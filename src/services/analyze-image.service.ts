import { ApiError } from "../middleware/api-error";

type AnalyzeInput = {
  imageBase64: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  mealDate?: string;
};

type AnalyzeOutput = {
  description: string;
  ingredients: Array<{
    name: string;
    quantity_g: number;
    source: "visible" | "inferred" | "manual";
    confidence?: number;
  }>;
  total_weight_g: number;
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

type ProviderName = "openai" | "google";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRIES = 1;

function isProductionEnvironment(): boolean {
  return (process.env.NODE_ENV || "development").toLowerCase() === "production";
}

function canUseMockFallback(): boolean {
  const configured = process.env.ALLOW_MOCK_AI;
  if (configured !== undefined) {
    return configured.toLowerCase() === "true";
  }

  // Safe default: allow mock only outside production.
  return !isProductionEnvironment();
}

async function callProviderWithResilience(
  provider: ProviderName,
  input: AnalyzeInput,
): Promise<AnalyzeOutput> {
  const timeoutMs = Number(
    process.env.AI_PROVIDER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
  );
  const retries = Number(process.env.AI_PROVIDER_RETRIES || DEFAULT_RETRIES);

  const url =
    provider === "openai"
      ? process.env.OPENAI_VISION_URL
      : process.env.GOOGLE_VISION_URL;

  const apiKey =
    provider === "openai"
      ? process.env.OPENAI_API_KEY
      : process.env.GOOGLE_VISION_API_KEY;

  if (!url || !apiKey) {
    throw new Error(`Provider ${provider} is not configured`);
  }

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Provider ${provider} failed with status ${response.status}`,
        );
      }

      const payload = (await response.json()) as Partial<AnalyzeOutput>;
      if (!payload.description) {
        throw new Error(`Provider ${provider} returned invalid payload`);
      }

      return {
        description: payload.description,
        ingredients: payload.ingredients ?? [],
        total_weight_g: payload.total_weight_g ?? 0,
        calories_kcal: payload.calories_kcal ?? 0,
        protein_g: payload.protein_g ?? 0,
        carbs_g: payload.carbs_g ?? 0,
        fat_g: payload.fat_g ?? 0,
      };
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      const backoffMs = 250 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`Provider ${provider} exhausted retries`);
}

function mockAnalyze(input: AnalyzeInput): AnalyzeOutput {
  return {
    description: `Mock analysis for ${input.mimeType}`,
    ingredients: [],
    total_weight_g: 0,
    calories_kcal: 0,
    protein_g: 0,
    carbs_g: 0,
    fat_g: 0,
  };
}

export async function analyzeImageWithFallback(
  input: AnalyzeInput,
): Promise<AnalyzeOutput> {
  try {
    return await callProviderWithResilience("openai", input);
  } catch {
    try {
      return await callProviderWithResilience("google", input);
    } catch {
      const allowMock = canUseMockFallback();
      if (allowMock) {
        return mockAnalyze(input);
      }
      throw new ApiError(502, "AI_PROVIDER_ERROR", "All AI providers failed");
    }
  }
}
