// Feature 026 — nutrition-label extraction via Gemini (contract §3.2,
// AC-026-08). Reuses the OpenAI-compatible endpoint and the exact resilience
// pattern of geminiVisionClient (timeout, retries, thinking disabled, JSON
// response). The result is NEVER persisted directly: the user confirms or
// corrects the values before POST /products (AC-026-10, BR-026-06).

import {
  PermanentProviderError,
  TransientProviderError,
} from "./providerErrors";

const DEFAULT_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";
const DEFAULT_MODEL = "gemini-2.5-flash";
const TIMEOUT_MS = 12_000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [1_000, 2_000] as const;

export type LabelExtraction = {
  isLabel: boolean;
  caloriesKcal100g: number;
  proteinG100g: number;
  carbsG100g: number;
  fatG100g: number;
  servingSizeG?: number;
  confidence: number;
};

const SYSTEM_PROMPT =
  "You are a nutrition-label reading assistant. You receive a photo of a " +
  "packaged food's nutrition facts table and return its macros normalized " +
  "PER 100g. Respond with ONLY a JSON object — no markdown fences, no prose.";

const USER_PROMPT = [
  "Read the nutrition facts table in this image and return exactly:",
  "{",
  '  "is_label": boolean,            // true ONLY if a legible nutrition facts table is visible',
  '  "calories_kcal_100g": number,   // kcal per 100g (NOT kJ)',
  '  "protein_g_100g": number,',
  '  "carbs_g_100g": number,',
  '  "fat_g_100g": number,',
  '  "serving_size_g": number|null,  // serving/portion size in grams if stated',
  '  "confidence": number            // 0..1',
  "}",
  "",
  "Rules:",
  "- Labels may be in Spanish or other languages (valor energético, proteínas,",
  "  hidratos de carbono, grasas).",
  "- ALWAYS normalize to per-100g: if the table only gives per-serving values,",
  "  convert using the stated serving size; if the table gives kJ only,",
  "  convert to kcal (1 kcal = 4.184 kJ).",
  "- If no legible nutrition table is visible (wrong photo, blur, front of",
  '  pack), set is_label=false and all numbers to 0. Never invent values.',
  "- Return ONLY the JSON object.",
].join("\n");

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

export async function extractNutritionLabel(input: {
  imageBase64: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
}): Promise<LabelExtraction> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new TransientProviderError("gemini", "GEMINI_API_KEY not configured");
  }

  const baseUrl = (process.env.GEMINI_BASE_URL || DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const clean = input.imageBase64.replace(/^data:[^;]+;base64,/, "");
  const dataUri = `data:${input.mimeType};base64,${clean}`;

  const body = JSON.stringify({
    model,
    max_tokens: 1024,
    extra_body: { google: { thinking_config: { thinking_budget: 0 } } },
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUri } },
          { type: "text", text: USER_PROMPT },
        ],
      },
    ],
  });

  let lastError: Error = new Error("no attempt made");

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        if (res.status === 429 || res.status >= 500) {
          throw new TransientProviderError(
            "gemini",
            `Gemini server error: ${res.status} ${detail}`.trim(),
          );
        }
        throw new PermanentProviderError(
          "gemini",
          res.status,
          `Gemini rejected request: ${res.status} ${detail}`.trim(),
        );
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(stripJsonFences(content)) as Record<
          string,
          unknown
        >;
      } catch {
        throw new TransientProviderError(
          "gemini",
          "Gemini label response is not valid JSON",
        );
      }

      const servingSize = Number(parsed.serving_size_g);
      return {
        isLabel: parsed.is_label === true,
        caloriesKcal100g: toNumber(parsed.calories_kcal_100g),
        proteinG100g: toNumber(parsed.protein_g_100g),
        carbsG100g: toNumber(parsed.carbs_g_100g),
        fatG100g: toNumber(parsed.fat_g_100g),
        servingSizeG:
          Number.isFinite(servingSize) && servingSize >= 1 && servingSize <= 5000
            ? servingSize
            : undefined,
        confidence: Math.min(1, Math.max(0, toNumber(parsed.confidence))),
      };
    } catch (err) {
      if (err instanceof PermanentProviderError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_BACKOFF_MS[attempt] ?? 2_000),
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new TransientProviderError(
    "gemini",
    `Label extraction unavailable after ${MAX_RETRIES + 1} attempts: ${lastError.message}`,
  );
}
