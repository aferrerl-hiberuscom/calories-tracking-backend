// Feature 027 — dish-name inference via Gemini, TEXT-ONLY (contract §3.1,
// AC-027-06/08). Cheapest possible call: no image, tiny prompt, thinking
// disabled. Callers treat any provider failure as "no suggestion" — the flow
// must never block on this (BR-027-03).

import {
  PermanentProviderError,
  TransientProviderError,
} from "./providerErrors";

const DEFAULT_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";
const DEFAULT_MODEL = "gemini-2.5-flash";
const TIMEOUT_MS = 8_000;
const MAX_RETRIES = 1; // best-effort call: fail fast, the client has a default
const RETRY_BACKOFF_MS = 1_000;

export type DishNameSuggestion = {
  dishName: string | null;
  confidence: number;
};

function buildPrompt(names: string[]): string {
  return [
    "Estos son los ingredientes de un plato:",
    names.map((n) => `- ${n}`).join("\n"),
    "",
    "Devuelve SOLO un objeto JSON con el nombre más natural del plato en",
    'español (máximo 120 caracteres) y tu confianza: {"dish_name": string,',
    '"confidence": number entre 0 y 1}.',
    'Ejemplo: lechuga + croutons + parmesano + pollo + salsa césar →',
    '{"dish_name": "Ensalada césar", "confidence": 0.9}.',
    "Si los ingredientes no sugieren ningún plato reconocible, usa un nombre",
    'descriptivo simple (p. ej. "Bol de pollo con arroz") con confianza baja.',
    "Sin markdown, sin texto extra.",
  ].join("\n");
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

export async function suggestDishNameWithGemini(
  ingredientNames: string[],
): Promise<DishNameSuggestion> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new TransientProviderError("gemini", "GEMINI_API_KEY not configured");
  }

  const baseUrl = (process.env.GEMINI_BASE_URL || DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;

  const body = JSON.stringify({
    model,
    max_tokens: 256,
    extra_body: { google: { thinking_config: { thinking_budget: 0 } } },
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: buildPrompt(ingredientNames) }],
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
        const detail = (await res.text().catch(() => "")).slice(0, 200);
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
      const parsed = JSON.parse(stripJsonFences(content)) as {
        dish_name?: unknown;
        confidence?: unknown;
      };

      const name = String(parsed.dish_name ?? "").trim();
      const confidence = Number(parsed.confidence);
      return {
        dishName: name ? name.slice(0, 120) : null,
        confidence: Number.isFinite(confidence)
          ? Math.min(1, Math.max(0, confidence))
          : 0,
      };
    } catch (err) {
      if (err instanceof PermanentProviderError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new TransientProviderError(
    "gemini",
    `Dish-name inference unavailable: ${lastError.message}`,
  );
}
