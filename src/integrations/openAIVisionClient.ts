// Portion-estimation vision client — feature 007
// Estimates ingredient quantities from an image. Backed by Google Gemini
// (AI Studio, free tier) via its OpenAI-compatible endpoint. File name and
// exports (analyzePortions / VisionApiError) are preserved to avoid churn in
// estimateQuantities.service and its tests.

import { ApiError } from "../middleware/api-error";
import type { IngredientInput } from "../types/estimateQuantities.types";

const DEFAULT_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";
const DEFAULT_MODEL = "gemini-2.5-flash";
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [1_000, 2_000] as const;

type PortionEstimate = {
  name: string;
  quantity_g: number;
  confidence: number;
  source: "vision" | "missing";
};

export class VisionApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionApiError";
  }
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

// Gemini's OpenAI-compatible endpoint is most reliable with inlined base64
// images, so fetch the (public) image URL once and convert to a data URI.
async function toDataUri(imageUrl: string): Promise<string> {
  if (imageUrl.startsWith("data:")) return imageUrl;
  const res = await fetchWithTimeout(
    imageUrl,
    { method: "GET" },
    REQUEST_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new VisionApiError(`Could not fetch image (${res.status})`);
  }
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  const buffer = Buffer.from(await res.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

function buildPrompt(ingredients: IngredientInput[]): string {
  const list = ingredients.map((i) => `- ${i.name}`).join("\n");
  return [
    "Analyze the food image and estimate the weight in grams for each ingredient listed below.",
    'Return a JSON array with objects containing: name (string), quantity_g (number), confidence (0-1), source ("vision").',
    "",
    "Ingredients to estimate:",
    list,
    "",
    "Rules:",
    "- quantity_g must be between 1 and 5000",
    "- confidence reflects your certainty (1.0 = certain, 0.0 = guessing)",
    '- If you cannot estimate an ingredient, set confidence to 0 and source to "missing"',
    "- Return ONLY valid JSON array, no markdown fences.",
  ].join("\n");
}

async function callOnce(
  imageUrl: string,
  ingredients: IngredientInput[],
): Promise<PortionEstimate[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new VisionApiError("GEMINI_API_KEY not configured");
  }

  const baseUrl = (process.env.GEMINI_BASE_URL || DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;

  const body = JSON.stringify({
    model,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: imageUrl },
          },
          {
            type: "text",
            text: buildPrompt(ingredients),
          },
        ],
      },
    ],
  });

  const res = await fetchWithTimeout(
    `${baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
    },
    REQUEST_TIMEOUT_MS,
  );

  if (!res.ok) {
    throw new VisionApiError(`Gemini API returned ${res.status}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content ?? "[]";

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(raw));
  } catch {
    throw new VisionApiError("Gemini response is not valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new VisionApiError("OpenAI response is not an array");
  }

  return parsed.map((item: Record<string, unknown>) => ({
    name: String(item.name ?? ""),
    quantity_g: Number(item.quantity_g ?? 0),
    confidence: Math.min(1, Math.max(0, Number(item.confidence ?? 0))),
    source:
      item.source === "missing" ? ("missing" as const) : ("vision" as const),
  }));
}

export async function analyzePortions(
  imageUrl: string,
  ingredients: IngredientInput[],
): Promise<PortionEstimate[]> {
  const imageSource = await toDataUri(imageUrl);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await callOnce(imageSource, ingredients);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_BACKOFF_MS[attempt]),
        );
      }
    }
  }

  throw new VisionApiError(
    `Vision API unavailable after ${MAX_RETRIES} attempts: ${lastError?.message}`,
  );
}
