import { createHash } from "crypto";
import { ApiError } from "../middleware/api-error";
import {
  PermanentProviderError,
  TransientProviderError,
  type VisionProvider,
} from "../integrations/providerErrors";
import { analyzeDishWithGemini } from "../integrations/geminiVisionClient";
import {
  calculateMacros,
  getNutritionalCatalogNames,
  lookupNutritionalDataDetailed,
  type DetailedNutritionLookup,
} from "./nutritionalData.service";

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
  source: "INFERRED" | "MANUAL" | "INFERRED_PARTIAL";
  confidence: number;
  cooking_method: CookingMethod;
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
  provider: VisionProvider;
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
  | "MIXED"
  | "UNKNOWN";
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
  source: "gemini_vision" | "openai_vision" | "google_vision";
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
  /** Canonical nutritional_reference entry chosen by the LLM (semantic match), if any. */
  catalog_name?: string;
  quantity_g?: number;
  confidence?: number;
  cooking_method?: string;
  calories_kcal?: number;
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
};

export type RawProviderResponse = {
  is_food?: boolean;
  rejection_reason?: string;
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

// Error classes (PermanentProviderError / TransientProviderError) live in
// ../integrations/providerErrors so provider clients can share them.

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

/** Hybrid DB macros: opt-in via MACROS_FROM_DB=true (off by default → tests never touch the DB). */
function macrosFromDbEnabled(): boolean {
  return (process.env.MACROS_FROM_DB ?? "").toLowerCase() === "true";
}

function normalizeIngredients(
  raw: RawProviderIngredient[],
  dishCookingMethod: CookingMethod,
): IngredientResult[] {
  return raw.map((item) => {
    const confidence = item.confidence ?? 0;
    const rawName = (item.name ?? "Unknown").trim();
    return {
      name: rawName.slice(0, 120),
      quantity_g: item.quantity_g ?? 0,
      source: "INFERRED" as const,
      confidence,
      cooking_method: item.cooking_method
        ? normalizeCookingMethod(item.cooking_method)
        : dishCookingMethod,
      calories_kcal: item.calories_kcal ?? 0,
      protein_g: item.protein_g ?? 0,
      carbs_g: item.carbs_g ?? 0,
      fat_g: item.fat_g ?? 0,
    };
  });
}

export function normalizeCookingMethod(raw: string | undefined): CookingMethod {
  if (!raw) return "UNKNOWN";
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
    "UNKNOWN",
  ];
  if (enumValues.includes(upper as CookingMethod))
    return upper as CookingMethod;
  return "UNKNOWN";
}

// ─── Feature 006: Duplicate merging ──────────────────────────────────────────

export function deduplicateIngredients(
  ingredients: IngredientResult[],
): IngredientResult[] {
  const map = new Map<string, IngredientResult[]>();

  for (const ing of ingredients) {
    const key = ing.name.toLowerCase().trim();
    const group = map.get(key);
    if (group) {
      group.push(ing);
    } else {
      map.set(key, [ing]);
    }
  }

  return Array.from(map.values()).map((group) => {
    if (group.length === 1) return group[0];

    const totalQty = group.reduce((s, i) => s + i.quantity_g, 0);
    const weightedConf =
      totalQty > 0
        ? group.reduce((s, i) => s + i.confidence * i.quantity_g, 0) / totalQty
        : group.reduce((s, i) => s + i.confidence, 0) / group.length;

    // cooking_method from the entry with highest quantity_g
    const dominant = group.reduce((a, b) =>
      a.quantity_g >= b.quantity_g ? a : b,
    );

    return {
      name: group[0].name,
      quantity_g: totalQty,
      source: group[0].source,
      confidence: Math.round(weightedConf * 1000) / 1000,
      cooking_method: dominant.cooking_method,
      calories_kcal: group.reduce((s, i) => s + i.calories_kcal, 0),
      protein_g: group.reduce((s, i) => s + i.protein_g, 0),
      carbs_g: group.reduce((s, i) => s + i.carbs_g, 0),
      fat_g: group.reduce((s, i) => s + i.fat_g, 0),
    };
  });
}

// ─── Feature 006: Weight consistency normalization ───────────────────────────

export function normalizeWeightConsistency(
  ingredients: IngredientResult[],
  totalWeight: number,
): {
  ingredients: IngredientResult[];
  normalized: boolean;
  originalTotal: number;
} {
  const originalTotal = ingredients.reduce((s, i) => s + i.quantity_g, 0);

  if (ingredients.length === 0 || totalWeight === 0 || originalTotal === 0) {
    return { ingredients, normalized: false, originalTotal };
  }

  const diff = Math.abs(originalTotal - totalWeight) / totalWeight;

  if (diff <= 0.1) {
    return { ingredients, normalized: false, originalTotal };
  }

  const factor = totalWeight / originalTotal;
  const scaled = ingredients.map((ing) => {
    const qty = Math.round(ing.quantity_g * factor * 100) / 100;
    const ratio = qty / (ing.quantity_g || 1);
    return {
      ...ing,
      quantity_g: qty,
      calories_kcal: Math.round(ing.calories_kcal * ratio * 100) / 100,
      protein_g: Math.round(ing.protein_g * ratio * 100) / 100,
      carbs_g: Math.round(ing.carbs_g * ratio * 100) / 100,
      fat_g: Math.round(ing.fat_g * ratio * 100) / 100,
    };
  });

  return { ingredients: scaled, normalized: true, originalTotal };
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
        cooking_method: "MIXED",
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

  // Primary provider: Google Gemini (AI Studio, free tier).
  // Gated on GEMINI_API_KEY so the existing OpenAI/Google tests (which never set
  // it) keep exercising the OpenAI → Google → mock chain below unchanged.
  if (process.env.GEMINI_API_KEY) {
    let geminiResult: Awaited<ReturnType<typeof analyzeDishWithGemini>> | null =
      null;
    // Inject the nutritional catalog so Gemini maps each ingredient to a
    // canonical entry (semantic matching for the hybrid DB-macros step).
    let catalogNames: string[] = [];
    try {
      catalogNames = macrosFromDbEnabled()
        ? await getNutritionalCatalogNames()
        : [];
      geminiResult = await analyzeDishWithGemini(input, { catalogNames });
    } catch (geminiErr) {
      const isPermanent = geminiErr instanceof PermanentProviderError;
      structuredLog({
        level: "warn",
        provider: "gemini",
        userId: input.userId,
        input_hash: inputHash,
        error:
          geminiErr instanceof Error ? geminiErr.message : String(geminiErr),
        action: isPermanent
          ? "no_fallback_permanent_error"
          : "gemini_failed_trying_fallback",
      });

      if (isPermanent) {
        throw new ApiError(
          400,
          "IA_INVALID_REQUEST",
          "AI provider rejected the image",
        );
      }
      // Transient — fall through to the OpenAI → Google → mock chain below.
    }

    if (geminiResult) {
      // Reject non-food images explicitly — never register a meal for them, and
      // never fall back to the mock (which would fabricate food). This is thrown
      // OUTSIDE the try above so it is not swallowed as a provider failure.
      if (geminiResult.raw.is_food === false) {
        structuredLog({
          level: "info",
          provider: "gemini",
          userId: input.userId,
          input_hash: inputHash,
          status: "rejected_not_food",
        });
        throw new ApiError(
          422,
          "NOT_FOOD",
          geminiResult.raw.rejection_reason?.trim() ||
            "La imagen no parece contener comida.",
        );
      }

      return buildAnalyzeOutput({
        raw: geminiResult.raw,
        providerName: "gemini",
        modelName: geminiResult.model,
        latency_ms: geminiResult.latency_ms,
        usedFallback: false,
        inputHash,
        userId: input.userId,
        catalogSize: catalogNames.length,
      });
    }
  }

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

  return buildAnalyzeOutput({
    raw,
    providerName,
    modelName,
    latency_ms,
    usedFallback,
    inputHash,
    userId: input.userId,
  });
}

// ─── Hybrid macro reconciliation (feature: macros from DB) ──────────────────────

export type MacroLookupFn = (name: string) => Promise<DetailedNutritionLookup>;

/**
 * Recalculate macros from the nutritional_reference DB for every ingredient
 * with a REAL catalog match (exact/alias, including the LLM-chosen catalog_name);
 * ingredients without a trustworthy match keep their AI-estimated macros.
 * Pure orchestration — lookup is injectable for testing.
 */
export async function reconcileMacrosWithDb(
  ingredients: IngredientResult[],
  catalogNameFor: (ingredientName: string) => string | undefined,
  lookup: MacroLookupFn = lookupNutritionalDataDetailed,
): Promise<{
  ingredients: IngredientResult[];
  matches: number;
  /** Canonical DB name per ingredient (aligned with `ingredients`), null = no match. */
  matchedNames: (string | null)[];
}> {
  const results = await Promise.all(
    ingredients.map(async (ing) => {
      if (ing.quantity_g <= 0) return { ing, matchedName: null };

      const candidates = [catalogNameFor(ing.name), ing.name].filter(
        (c): c is string => Boolean(c && c.trim()),
      );

      for (const candidate of candidates) {
        const result = await lookup(candidate);
        if (result.matched) {
          return {
            ing: { ...ing, ...calculateMacros(ing.quantity_g, result.nutrition) },
            matchedName: result.matchedName ?? candidate,
          };
        }
      }
      return { ing, matchedName: null }; // no trustworthy match — keep AI macros
    }),
  );

  return {
    ingredients: results.map((r) => r.ing),
    matches: results.filter((r) => r.matchedName !== null).length,
    matchedNames: results.map((r) => r.matchedName),
  };
}

// ─── Output builder (shared by all providers) ───────────────────────────────────

async function buildAnalyzeOutput(params: {
  raw: RawProviderResponse;
  providerName: VisionProvider;
  modelName: string;
  latency_ms: number;
  usedFallback: boolean;
  inputHash: string;
  userId?: string;
  /** Nº of catalog entries injected into the prompt (diagnostics only). */
  catalogSize?: number;
}): Promise<AnalyzeOutput> {
  const {
    raw,
    providerName,
    modelName,
    latency_ms,
    usedFallback,
    inputHash,
    userId,
  } = params;

  // Normalize response
  const cookingMethod = normalizeCookingMethod(raw.cooking_method_raw);
  const rawIngredients = normalizeIngredients(
    raw.ingredients ?? [],
    cookingMethod,
  );
  const deduped = deduplicateIngredients(rawIngredients);
  const weightResult = normalizeWeightConsistency(
    deduped,
    raw.total_weight_g ?? 0,
  );
  let ingredients = weightResult.ingredients;

  // Hybrid DB macros: after weights are final, override AI macros with per-100g
  // DB values for real catalog matches only; unmatched keep AI estimates.
  let dbMacroMatches = 0;
  if (macrosFromDbEnabled()) {
    const catalogByName = new Map<string, string>();
    for (const item of raw.ingredients ?? []) {
      if (item?.name && item.catalog_name) {
        catalogByName.set(
          String(item.name).trim().toLowerCase(),
          String(item.catalog_name),
        );
      }
    }
    const reconciled = await reconcileMacrosWithDb(ingredients, (n) =>
      catalogByName.get(n.trim().toLowerCase()),
    );

    // Dev-only matching detail (exception to the "no LLM content in logs"
    // rule, never emitted in production): per-ingredient name, the catalog
    // entry Gemini chose, and what actually matched in the DB — without this
    // a db_macro_matches:0 is undiagnosable.
    if (!isProductionEnvironment()) {
      structuredLog({
        level: "debug",
        action: "db_macro_matching",
        input_hash: inputHash,
        detail: ingredients.map((ing, i) => ({
          name: ing.name,
          catalog_name: catalogByName.get(ing.name.trim().toLowerCase()) ?? null,
          db_match: reconciled.matchedNames[i] ?? null,
        })),
      });
    }

    ingredients = reconciled.ingredients;
    dbMacroMatches = reconciled.matches;
  }

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

  // Build Feature 005+006 contract fields
  const dishConfidence =
    raw.confidence ??
    (confidenceScores.length > 0
      ? confidenceScores.reduce((a, b) => a + b, 0) / confidenceScores.length
      : 0);
  const confidenceLevel = classifyConfidenceLevel(dishConfidence);
  const hasLowConfidence = ingredients.some((i) => i.confidence < 0.5);

  const dishDescriptionStructured: DishDescription = {
    dish_name: raw.dish_name ?? raw.dish_description ?? "Unknown dish",
    description:
      raw.dish_description ?? raw.description ?? "No description available",
    cuisine_type: raw.cuisine_type ?? "Unknown",
    cooking_method: cookingMethod,
  };

  const provenanceSource: Provenance["source"] =
    providerName === "gemini"
      ? "gemini_vision"
      : providerName === "openai"
        ? "openai_vision"
        : "google_vision";

  const provenance: Provenance = {
    source: provenanceSource,
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
    userId,
    input_hash: inputHash,
    latency_ms,
    status: "success",
    fallback: usedFallback,
    confidence: dishConfidence,
    confidence_level: confidenceLevel,
    analysis_status: analysisStatus,
    macros_from_db: macrosFromDbEnabled(),
    db_macro_matches: dbMacroMatches,
    catalog_size: params.catalogSize,
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
