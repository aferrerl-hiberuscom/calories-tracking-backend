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
  source: "ai_inferred" | "source_manual";
  confidence: number;
  low_confidence: boolean;
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

// ─── Feature 005 contract types ──────────────────────────────────────────────

export type CookingMethod =
  | "FRIED"
  | "BAKED"
  | "GRILLED"
  | "BOILED"
  | "RAW"
  | "MIXED";
export type ConfidenceLevel =
  | "HIGH_CONFIDENCE"
  | "MEDIUM_CONFIDENCE"
  | "LOW_CONFIDENCE";
export type AnalysisStatus = "COMPLETED" | "COMPLETED_WITH_WARNINGS";

export type DishDescription = {
  dish_name: string;
  description: string;
  cuisine_type: string;
  cooking_method: CookingMethod;
};

export type Provenance = {
  source: "openai_vision" | "google_vision";
  model: string;
  processed_at: string; // ISO 8601
};

export type AnalyzeOutput = {
  // Feature 005 contract fields
  dish_description_structured: DishDescription;
  estimated_weight_g: number;
  confidence: number;
  confidence_level: ConfidenceLevel;
  provenance: Provenance;
  status: AnalysisStatus;
  // Preserved for downstream features 006–009
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
  dish_name?: string;
  cuisine_type?: string;
  cooking_method_raw?: string;
  confidence?: number;
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
const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.6;

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
  const threshold = Number(
    process.env.LOW_CONFIDENCE_THRESHOLD ?? DEFAULT_LOW_CONFIDENCE_THRESHOLD,
  );
  return raw.map((item) => {
    const confidence = item.confidence ?? 0;
    return {
      name: item.name ?? "Unknown",
      quantity_g: item.quantity_g ?? 0,
      source: "ai_inferred" as const,
      confidence,
      low_confidence: confidence < threshold,
      calories_kcal: item.calories_kcal ?? 0,
      protein_g: item.protein_g ?? 0,
      carbs_g: item.carbs_g ?? 0,
      fat_g: item.fat_g ?? 0,
    };
  });
}

export function normalizeCookingMethod(raw: string | undefined): CookingMethod {
  if (!raw) return "MIXED";
  const upper = raw.toUpperCase().trim();
  if (["GRILLING", "GRILL", "GRILLED"].includes(upper)) return "GRILLED";
  if (["ROASTING", "ROASTED", "BAKING", "BAKED"].includes(upper))
    return "BAKED";
  if (["FRYING", "FRIED", "FRITO", "FRITURA"].includes(upper)) return "FRIED";
  if (["BOILING", "BOILED", "HERVIDO", "COCIDO"].includes(upper))
    return "BOILED";
  if (["RAW", "CRUDO", "CRUDA"].includes(upper)) return "RAW";
  if (["MIXED", "MIXTO", "MIXED_METHODS"].includes(upper)) return "MIXED";
  // Direct enum match
  const enumValues: CookingMethod[] = [
    "FRIED",
    "BAKED",
    "GRILLED",
    "BOILED",
    "RAW",
    "MIXED",
  ];
  if (enumValues.includes(upper as CookingMethod))
    return upper as CookingMethod;
  return "MIXED";
}

export function classifyConfidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= 0.7) return "HIGH_CONFIDENCE";
  if (confidence >= 0.5) return "MEDIUM_CONFIDENCE";
  return "LOW_CONFIDENCE";
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
    dish_name: "Mock Dish",
    cuisine_type: "Unknown",
    cooking_method_raw: "MIXED",
    confidence: 0.8,
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

  // Build Feature 005 contract fields
  const cookingMethod = normalizeCookingMethod(raw.cooking_method_raw);
  const dishConfidence =
    raw.confidence ??
    (confidenceScores.length > 0
      ? confidenceScores.reduce((a, b) => a + b, 0) / confidenceScores.length
      : 0);
  const confidenceLevel = classifyConfidenceLevel(dishConfidence);
  const hasLowConfidence = ingredients.some((i) => i.low_confidence);

  const dishDescriptionStructured: DishDescription = {
    dish_name: raw.dish_name ?? raw.dish_description ?? "Unknown dish",
    description:
      raw.dish_description ?? raw.description ?? "No description available",
    cuisine_type: raw.cuisine_type ?? "Unknown",
    cooking_method: cookingMethod,
  };

  const provenance: Provenance = {
    source: providerName === "openai" ? "openai_vision" : "google_vision",
    model: modelName,
    processed_at: metadata.timestamp,
  };

  const analysisStatus: AnalysisStatus = hasLowConfidence
    ? "COMPLETED_WITH_WARNINGS"
    : "COMPLETED";

  structuredLog({
    level: "info",
    provider: providerName,
    model: modelName,
    userId: input.userId,
    input_hash: inputHash,
    latency_ms,
    status: "success",
    fallback: usedFallback,
    confidence: dishConfidence,
    confidence_level: confidenceLevel,
    analysis_status: analysisStatus,
  });

  return {
    dish_description_structured: dishDescriptionStructured,
    estimated_weight_g: totals.weight_g,
    confidence: dishConfidence,
    confidence_level: confidenceLevel,
    provenance,
    status: analysisStatus,
    dish_description: raw.dish_description ?? "Unknown dish",
    ingredients,
    totals,
    metadata,
  };
}
