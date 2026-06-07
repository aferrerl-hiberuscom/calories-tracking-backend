import { createHash } from "crypto";
import { ApiError } from "../middleware/api-error";

// ─── Types ────────────────────────────────────────────────────────────────────

type SupportedMimeType = "image/jpeg" | "image/png" | "image/webp";

export type AnalyzeInput = {
  imageBase64: string;
  mimeType: SupportedMimeType;
  mealDate?: string;
  userId?: string;
};

export type IngredientResult = {
  name: string;
  quantity_g: number;
  source: "ai";
  confidence: number;
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

export type AnalyzeTotals = {
  weight_g: number;
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

export type AnalyzeMetadata = {
  provider: "openai" | "google";
  model: string;
  latency_ms: number;
  timestamp: string;
  input_hash: string;
  fallback: boolean;
  confidence_scores?: number[];
};

export type AnalyzeOutput = {
  dish_description: string;
  ingredients: IngredientResult[];
  totals: AnalyzeTotals;
  metadata: AnalyzeMetadata;
};

// Raw shape returned by AI providers (before normalization)
type RawProviderIngredient = {
  name?: string;
  quantity_g?: number;
  confidence?: number;
  calories_kcal?: number;
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
};

type RawProviderResponse = {
  description?: string;
  dish_description?: string;
  ingredients?: RawProviderIngredient[];
  total_weight_g?: number;
  calories_kcal?: number;
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
  model?: string;
};

// ─── Error classes ─────────────────────────────────────────────────────────────

class PermanentProviderError extends Error {
  constructor(
    public readonly provider: "openai" | "google",
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PermanentProviderError";
  }
}

class TransientProviderError extends Error {
  constructor(
    public readonly provider: "openai" | "google",
    message: string,
  ) {
    super(message);
    this.name = "TransientProviderError";
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const RETRY_BACKOFF_MS = [1_000, 2_000];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeInputHash(imageBase64: string): string {
  const clean = imageBase64.replace(/^data:[^;]+;base64,/, "");
  return createHash("sha256").update(clean).digest("hex");
}

function isProductionEnvironment(): boolean {
  return (process.env.NODE_ENV || "development").toLowerCase() === "production";
}

function canUseMockFallback(): boolean {
  const configured = process.env.ALLOW_MOCK_AI;
  if (configured !== undefined) {
    return configured.toLowerCase() === "true";
  }
  return !isProductionEnvironment();
}

function normalizeIngredients(
  raw: RawProviderIngredient[],
): IngredientResult[] {
  return raw.map((item) => ({
    name: item.name ?? "Unknown",
    quantity_g: item.quantity_g ?? 0,
    source: "ai" as const,
    confidence: item.confidence ?? 0,
    calories_kcal: item.calories_kcal ?? 0,
    protein_g: item.protein_g ?? 0,
    carbs_g: item.carbs_g ?? 0,
    fat_g: item.fat_g ?? 0,
  }));
}

function computeTotals(ingredients: IngredientResult[]): AnalyzeTotals {
  return ingredients.reduce(
    (acc, ing) => ({
      weight_g: acc.weight_g + ing.quantity_g,
      calories_kcal: acc.calories_kcal + ing.calories_kcal,
      protein_g: acc.protein_g + ing.protein_g,
      carbs_g: acc.carbs_g + ing.carbs_g,
      fat_g: acc.fat_g + ing.fat_g,
    }),
    { weight_g: 0, calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
  );
}

function structuredLog(fields: Record<string, unknown>): void {
  // Never log sensitive fields — enforced by type constraint
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    imageBase64: _image,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    apiKey: _key,
    ...safe
  } = fields as Record<string, unknown>;
  console.log(JSON.stringify({ ...safe, service: "analyze-image" }));
}

// ─── Provider call ─────────────────────────────────────────────────────────────

async function callProvider(
  provider: "openai" | "google",
  input: AnalyzeInput,
): Promise<{ raw: RawProviderResponse; model: string; latency_ms: number }> {
  const timeoutMs = Number(
    process.env.AI_PROVIDER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
  );
  const maxRetries = Number(process.env.AI_PROVIDER_RETRIES || DEFAULT_RETRIES);

  const url =
    provider === "openai"
      ? process.env.OPENAI_VISION_URL
      : process.env.GOOGLE_VISION_URL;

  const apiKey =
    provider === "openai"
      ? process.env.OPENAI_API_KEY
      : process.env.GOOGLE_VISION_API_KEY;

  if (!url || !apiKey) {
    throw new TransientProviderError(
      provider,
      `Provider ${provider} is not configured`,
    );
  }

  let lastError: Error = new Error("no attempt made");

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = Date.now();

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          imageBase64: input.imageBase64,
          mimeType: input.mimeType,
          mealDate: input.mealDate,
        }),
        signal: controller.signal,
      });

      const latency_ms = Date.now() - start;

      if (!response.ok) {
        const status = response.status;
        if (status >= 400 && status < 500) {
          // Permanent — do not retry
          throw new PermanentProviderError(
            provider,
            status,
            `Provider ${provider} rejected request: ${status}`,
          );
        }
        // Transient — may retry
        throw new TransientProviderError(
          provider,
          `Provider ${provider} server error: ${status}`,
        );
      }

      const payload = (await response.json()) as RawProviderResponse;
      const dishDescription = payload.dish_description ?? payload.description;

      if (!dishDescription) {
        throw new TransientProviderError(
          provider,
          `Provider ${provider} returned invalid payload: missing description`,
        );
      }

      return {
        raw: { ...payload, dish_description: dishDescription },
        model: payload.model ?? `${provider}-vision`,
        latency_ms,
      };
    } catch (err) {
      clearTimeout(timer);

      // Permanent errors are never retried
      if (err instanceof PermanentProviderError) {
        throw err;
      }

      lastError = err instanceof Error ? err : new Error(String(err));

      // Timeout / abort treated as transient
      if (attempt < maxRetries) {
        const backoff = RETRY_BACKOFF_MS[attempt] ?? 2_000;
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new TransientProviderError(
    provider,
    `Provider ${provider} exhausted retries: ${lastError.message}`,
  );
}

// ─── Mock fallback (dev/test only) ────────────────────────────────────────────

function mockAnalyze(input: AnalyzeInput): RawProviderResponse {
  return {
    dish_description: `Mock analysis for ${input.mimeType}`,
    ingredients: [
      {
        name: "Mock ingredient",
        quantity_g: 100,
        confidence: 0.9,
        calories_kcal: 200,
        protein_g: 10,
        carbs_g: 25,
        fat_g: 5,
      },
    ],
    total_weight_g: 100,
    calories_kcal: 200,
    protein_g: 10,
    carbs_g: 25,
    fat_g: 5,
    model: "mock-v1",
  };
}

// ─── Public API ────────────────────────────────────────────────────────────────

export async function analyzeImageWithFallback(
  input: AnalyzeInput,
): Promise<AnalyzeOutput> {
  const inputHash = computeInputHash(input.imageBase64);

  let raw: RawProviderResponse;
  let providerName: "openai" | "google";
  let modelName: string;
  let latency_ms: number;
  let usedFallback = false;

  // Attempt primary provider (OpenAI)
  try {
    const result = await callProvider("openai", input);
    raw = result.raw;
    providerName = "openai";
    modelName = result.model;
    latency_ms = result.latency_ms;
  } catch (primaryErr) {
    const isPermanent = primaryErr instanceof PermanentProviderError;

    structuredLog({
      level: "warn",
      provider: "openai",
      userId: input.userId,
      input_hash: inputHash,
      error:
        primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
      action: isPermanent
        ? "no_fallback_permanent_error"
        : "attempting_fallback",
    });

    if (isPermanent) {
      throw new ApiError(
        400,
        "IA_INVALID_REQUEST",
        "AI provider rejected the image",
      );
    }

    // Transient — try fallback provider (Google Vision)
    try {
      const result = await callProvider("google", input);
      raw = result.raw;
      providerName = "google";
      modelName = result.model;
      latency_ms = result.latency_ms;
      usedFallback = true;
    } catch (fallbackErr) {
      // Both providers failed — check mock
      const allowMock = canUseMockFallback();

      structuredLog({
        level: "error",
        provider: "google",
        userId: input.userId,
        input_hash: inputHash,
        error:
          fallbackErr instanceof Error
            ? fallbackErr.message
            : String(fallbackErr),
        action: allowMock ? "using_mock" : "all_providers_failed",
      });

      if (allowMock) {
        raw = mockAnalyze(input);
        providerName = "openai";
        modelName = "mock-v1";
        latency_ms = 0;
        usedFallback = true;
      } else {
        throw new ApiError(
          503,
          "IA_UNAVAILABLE",
          "AI analysis service is temporarily unavailable",
        );
      }
    }
  }

  // Normalize response
  const ingredients = normalizeIngredients(raw.ingredients ?? []);
  const totals = computeTotals(ingredients);
  const confidenceScores = ingredients.map((i) => i.confidence);

  const metadata: AnalyzeMetadata = {
    provider: providerName,
    model: modelName,
    latency_ms,
    timestamp: new Date().toISOString(),
    input_hash: inputHash,
    fallback: usedFallback,
    confidence_scores:
      confidenceScores.length > 0 ? confidenceScores : undefined,
  };

  structuredLog({
    level: "info",
    provider: providerName,
    model: modelName,
    userId: input.userId,
    input_hash: inputHash,
    latency_ms,
    status: "success",
    fallback: usedFallback,
  });

  return {
    dish_description: raw.dish_description ?? "Unknown dish",
    ingredients,
    totals,
    metadata,
  };
}
