// Google Gemini (AI Studio) vision client — primary dish-analysis provider.
//
// Uses Gemini's OpenAI-compatible endpoint so it mirrors the chat-completions
// shape already used elsewhere in this codebase. Returns the provider-neutral
// RawProviderResponse consumed by analyze-image.service.
//
// Config (env):
//   GEMINI_API_KEY   (required)  — free key from https://aistudio.google.com
//   GEMINI_MODEL     (optional)  — defaults to "gemini-2.0-flash"
//   GEMINI_BASE_URL  (optional)  — fixed OpenAI-compat base; defaults below

import {
  PermanentProviderError,
  TransientProviderError,
} from "./providerErrors";
import type { RawProviderResponse } from "../services/analyze-image.service";

const DEFAULT_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";
const DEFAULT_MODEL = "gemini-2.5-flash";
const TIMEOUT_MS = 12_000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [1_000, 2_000] as const;

type GeminiInput = {
  imageBase64: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
};

const SYSTEM_PROMPT =
  "You are a nutrition vision assistant. First decide whether the photo actually " +
  "contains food or drink. If it does, describe the dish and its ingredients with " +
  "estimated weights and macronutrients. If it does NOT, say so and do not invent " +
  "any food. Respond with ONLY a JSON object — no markdown fences, no extra text.";

const USER_PROMPT = [
  "Analyze this image and return a JSON object with exactly these fields:",
  "{",
  '  "is_food": boolean,                // true ONLY if the image clearly shows food or drink',
  '  "rejection_reason": string,        // if is_food is false, briefly say (in Spanish) what the image shows instead; otherwise ""',
  '  "dish_name": string,',
  '  "dish_description": string,        // short natural-language description',
  '  "cuisine_type": string,            // e.g. "Italian", "Mexican", "Unknown"',
  '  "cooking_method_raw": string,      // FRIED|BAKED|GRILLED|BOILED|RAW|MIXED|UNKNOWN',
  '  "confidence": number,              // 0..1 overall confidence',
  '  "total_weight_g": number,          // estimated total edible weight (g)',
  '  "ingredients": [',
  "    {",
  '      "name": string,',
  '      "quantity_g": number,          // 1..5000',
  '      "confidence": number,          // 0..1',
  '      "cooking_method": string,      // FRIED|BAKED|GRILLED|BOILED|RAW|MIXED|UNKNOWN',
  '      "calories_kcal": number,',
  '      "protein_g": number,',
  '      "carbs_g": number,',
  '      "fat_g": number',
  "    }",
  "  ]",
  "}",
  "",
  "Rules:",
  "- If the image does NOT clearly contain food or drink (e.g. a table, a person,",
  "  a landscape, an object, a screenshot), set is_food=false, ingredients=[], and",
  "  explain briefly in rejection_reason. Never invent food that is not visible.",
  "- Only when is_food=true, fill the dish fields and per-ingredient macros for",
  "  each ingredient's quantity_g.",
  "- quantity_g must be between 1 and 5000.",
  "- confidence: 1.0 = certain, 0.0 = guessing.",
  "- Return ONLY the JSON object, no markdown fences, no prose.",
].join("\n");

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function mapToRawResponse(
  parsed: Record<string, unknown>,
  model: string,
): RawProviderResponse {
  const rawIngredients = Array.isArray(parsed.ingredients)
    ? (parsed.ingredients as unknown[])
    : [];

  return {
    is_food: typeof parsed.is_food === "boolean" ? parsed.is_food : undefined,
    rejection_reason: toString(parsed.rejection_reason),
    dish_description: toString(
      parsed.dish_description ?? parsed.description ?? parsed.dish_name,
    ),
    description: toString(parsed.description),
    dish_name: toString(parsed.dish_name),
    cuisine_type: toString(parsed.cuisine_type),
    cooking_method_raw: toString(parsed.cooking_method_raw),
    confidence: toNumber(parsed.confidence),
    total_weight_g: toNumber(parsed.total_weight_g),
    ingredients: rawIngredients.map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return {
        name: toString(item.name),
        quantity_g: toNumber(item.quantity_g),
        confidence: toNumber(item.confidence),
        cooking_method: toString(item.cooking_method),
        calories_kcal: toNumber(item.calories_kcal),
        protein_g: toNumber(item.protein_g),
        carbs_g: toNumber(item.carbs_g),
        fat_g: toNumber(item.fat_g),
      };
    }),
    model,
  };
}

/**
 * Analyze a food image with Gemini and return a provider-neutral response.
 * Throws PermanentProviderError (bad request) or TransientProviderError
 * (timeout / rate limit / 5xx) so the caller can classify for fallback.
 */
export async function analyzeDishWithGemini(
  input: GeminiInput,
): Promise<{ raw: RawProviderResponse; model: string; latency_ms: number }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new TransientProviderError("gemini", "GEMINI_API_KEY not configured");
  }

  const baseUrl = (process.env.GEMINI_BASE_URL || DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `${baseUrl}/chat/completions`;

  const clean = input.imageBase64.replace(/^data:[^;]+;base64,/, "");
  const dataUri = `data:${input.mimeType};base64,${clean}`;

  const body = JSON.stringify({
    model,
    max_tokens: 2048,
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
    const start = Date.now();
    try {
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body,
        },
        TIMEOUT_MS,
      );

      const latency_ms = Date.now() - start;

      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 600);
        // 429 (rate limit) and 5xx are transient; other 4xx are permanent.
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
        parsed = JSON.parse(stripJsonFences(content)) as Record<string, unknown>;
      } catch {
        throw new TransientProviderError(
          "gemini",
          "Gemini response is not valid JSON",
        );
      }

      return { raw: mapToRawResponse(parsed, model), model, latency_ms };
    } catch (err) {
      // Permanent errors are never retried.
      if (err instanceof PermanentProviderError) {
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_BACKOFF_MS[attempt] ?? 2_000),
        );
      }
    }
  }

  throw new TransientProviderError(
    "gemini",
    `Gemini unavailable after ${MAX_RETRIES + 1} attempts: ${lastError.message}`,
  );
}
