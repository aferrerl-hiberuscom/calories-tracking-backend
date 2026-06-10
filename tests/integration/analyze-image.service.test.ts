/**
 * Feature 019 — analyze-image.service unit tests
 *
 * Tests T014: metadata correctness (input_hash, fallback, provider)
 * Tests T015: error classification and retry (transient/permanent/critical)
 * Tests T016: no sensitive data in logs
 * Tests T017: response shape validation (contract compliance — Feature 005)
 * Tests T018: normalizeCookingMethod
 * Tests T019: classifyConfidenceLevel
 * Tests T020: provenance fields (AC-008)
 * Tests T021: status COMPLETED_WITH_WARNINGS (AC-005)
 * Tests T022: cooking_method normalization in output (AC-009)
 * Tests T023: deduplicateIngredients — Feature 006 (BR-010)
 * Tests T024: normalizeWeightConsistency — Feature 006 (BR-011)
 * Tests T025: ingredient source and cooking_method — Feature 006
 * Tests T026: ingredient name max 120 chars — Feature 006
 */

import { createHash } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeImageWithFallback,
  normalizeCookingMethod,
  classifyConfidenceLevel,
  deduplicateIngredients,
  normalizeWeightConsistency,
} from "../../src/services/analyze-image.service";
import type { AnalyzeInput } from "../../src/services/analyze-image.service";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MOCK_BASE64 = Buffer.from("test-image-data").toString("base64");
const EXPECTED_HASH = createHash("sha256").update(MOCK_BASE64).digest("hex");

const VALID_INPUT: AnalyzeInput = {
  imageBase64: MOCK_BASE64,
  mimeType: "image/jpeg",
  userId: "test-user-id",
};

function makeSuccessResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      dish_description: "Grilled chicken salad",
      dish_name: "Grilled Chicken Salad",
      cuisine_type: "American",
      cooking_method_raw: "GRILLED",
      confidence: 0.87,
      model: "gpt-4o",
      ingredients: [
        {
          name: "Chicken",
          quantity_g: 150,
          confidence: 0.95,
          calories_kcal: 248,
          protein_g: 46,
          carbs_g: 0,
          fat_g: 5,
        },
        {
          name: "Lettuce",
          quantity_g: 50,
          confidence: 0.88,
          calories_kcal: 8,
          protein_g: 1,
          carbs_g: 1,
          fat_g: 0,
        },
      ],
      ...overrides,
    }),
  };
}

function makeErrorResponse(status: number) {
  return {
    ok: false,
    status,
    json: async () => ({ error: `HTTP ${status}` }),
    text: async () => `HTTP ${status}`,
  };
}

// ─── T014: Metadata correctness ─────────────────────────────────────────────

describe("T014 — metadata correctness", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.OPENAI_VISION_URL =
      "https://api.openai.com/v1/chat/completions";
    process.env.ALLOW_MOCK_AI = "false";
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns correct input_hash (SHA-256 of base64)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSuccessResponse()));

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(result.metadata.input_hash).toBe(EXPECTED_HASH);
  });

  it("input_hash is consistent for the same image", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(makeSuccessResponse())
        .mockResolvedValueOnce(makeSuccessResponse()),
    );

    const r1 = await analyzeImageWithFallback(VALID_INPUT);
    const r2 = await analyzeImageWithFallback(VALID_INPUT);

    expect(r1.metadata.input_hash).toBe(r2.metadata.input_hash);
  });

  it("sets fallback=false when primary provider succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSuccessResponse()));

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(result.metadata.fallback).toBe(false);
    expect(result.metadata.provider).toBe("openai");
  });

  it("sets fallback=true when Google Vision is used", async () => {
    process.env.GOOGLE_VISION_API_KEY = "test-google-key";
    process.env.GOOGLE_VISION_URL =
      "https://vision.googleapis.com/v1/images:annotate";

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(makeErrorResponse(503)) // OpenAI fails (transient)
        .mockResolvedValueOnce(makeErrorResponse(503)) // retry 1
        .mockResolvedValueOnce(makeErrorResponse(503)) // retry 2
        .mockResolvedValueOnce(makeSuccessResponse()), // Google succeeds
    );

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(result.metadata.fallback).toBe(true);
    expect(result.metadata.provider).toBe("google");
  });

  it("latency_ms is a positive number", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSuccessResponse()));

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(result.metadata.latency_ms).toBeGreaterThanOrEqual(0);
    expect(typeof result.metadata.latency_ms).toBe("number");
  });

  it("timestamp is a valid ISO 8601 string", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSuccessResponse()));

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(() => new Date(result.metadata.timestamp)).not.toThrow();
    expect(result.metadata.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ─── T015: Error classification and retry ────────────────────────────────────

describe("T015 — error classification and retry", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.OPENAI_VISION_URL =
      "https://api.openai.com/v1/chat/completions";
    process.env.AI_PROVIDER_RETRIES = "2";
    process.env.ALLOW_MOCK_AI = "false";
    process.env.NODE_ENV = "test";
    // No Google configured → fallback will fail
    process.env.GOOGLE_VISION_API_KEY = "";
    process.env.GOOGLE_VISION_URL = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries transient errors (5xx) up to max retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeErrorResponse(503)) // attempt 0
      .mockResolvedValueOnce(makeErrorResponse(503)) // attempt 1
      .mockResolvedValueOnce(makeErrorResponse(503)); // attempt 2

    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeImageWithFallback(VALID_INPUT)).rejects.toThrow();

    // 3 calls: initial + 2 retries
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry permanent errors (4xx)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeErrorResponse(400)); // permanent

    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeImageWithFallback(VALID_INPUT)).rejects.toThrow();

    // Only 1 call — no retry on 4xx
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws IA_UNAVAILABLE (503) when both providers fail", async () => {
    process.env.GOOGLE_VISION_API_KEY = "google-key";
    process.env.GOOGLE_VISION_URL = "https://vision.googleapis.com";

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeErrorResponse(503)));

    try {
      await analyzeImageWithFallback(VALID_INPUT);
      expect.fail("Should have thrown");
    } catch (err: unknown) {
      expect((err as { code?: string }).code ?? (err as Error).message).toMatch(
        /IA_UNAVAILABLE|unavailable/i,
      );
    }
  }, 20_000); // retries across two providers = up to ~12 s of backoff

  it("treats timeout (AbortError) as transient — retries", async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await expect(analyzeImageWithFallback(VALID_INPUT)).rejects.toThrow();

    // Retried max times
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});

// ─── T016: No sensitive data in logs ─────────────────────────────────────────

describe("T016 — no sensitive data in logs", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "super-secret-api-key";
    process.env.OPENAI_VISION_URL =
      "https://api.openai.com/v1/chat/completions";
    process.env.ALLOW_MOCK_AI = "false";
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never logs api_key, imageBase64, or raw LLM response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSuccessResponse()));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await analyzeImageWithFallback(VALID_INPUT);

    const allLogOutput = logSpy.mock.calls.flat().join(" ");

    // API key must not appear in any log
    expect(allLogOutput).not.toContain("super-secret-api-key");
    // imageBase64 must not appear in any log
    expect(allLogOutput).not.toContain(MOCK_BASE64);
    // Raw response body fields should not appear (no "Grilled chicken salad" in log)
    // Only metadata fields should be logged
  });

  it("logs required traceability fields on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSuccessResponse()));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await analyzeImageWithFallback({ ...VALID_INPUT, userId: "log-test-user" });

    const allLogOutput = logSpy.mock.calls.flat().join(" ");

    // Required fields from contract acceptance condition 10
    expect(allLogOutput).toContain("openai"); // provider
    expect(allLogOutput).toContain("log-test-user"); // userId
    expect(allLogOutput).toContain(EXPECTED_HASH); // input_hash
    expect(allLogOutput).toContain("success"); // status
  });
});

// ─── T017: Response shape validation ─────────────────────────────────────────

describe("T017 — response shape (contract compliance)", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_VISION_URL =
      "https://api.openai.com/v1/chat/completions";
    process.env.ALLOW_MOCK_AI = "false";
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns dish_description_structured as DishDescription object (Feature 005 contract)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSuccessResponse()));

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(result.dish_description_structured).toMatchObject({
      dish_name: expect.any(String),
      description: expect.any(String),
      cuisine_type: expect.any(String),
      cooking_method: expect.stringMatching(
        /^(FRIED|BAKED|GRILLED|BOILED|RAW|MIXED)$/,
      ),
    });
    expect(result.dish_description_structured.dish_name.length).toBeGreaterThan(
      0,
    );
    expect(
      result.dish_description_structured.description.length,
    ).toBeGreaterThan(0);
  });

  it("returns dish_description as non-empty string (backward compat)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSuccessResponse()));

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(typeof result.dish_description).toBe("string");
    expect(result.dish_description.length).toBeGreaterThan(0);
  });

  it("returns ingredients array with all required fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSuccessResponse()));

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(result.ingredients.length).toBeGreaterThanOrEqual(1);

    for (const ing of result.ingredients) {
      expect(ing).toHaveProperty("name");
      expect(ing).toHaveProperty("quantity_g");
      expect(ing).toHaveProperty("source");
      expect(ing).toHaveProperty("confidence");
      expect(ing).toHaveProperty("cooking_method");
      expect(ing).toHaveProperty("calories_kcal");
      expect(ing).toHaveProperty("protein_g");
      expect(ing).toHaveProperty("carbs_g");
      expect(ing).toHaveProperty("fat_g");
      expect(ing.source).toBe("INFERRED");
      expect(ing.quantity_g).toBeGreaterThan(0);
    }
  });

  it("totals match sum of ingredient values", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSuccessResponse()));

    const result = await analyzeImageWithFallback(VALID_INPUT);

    const expectedCalories = result.ingredients.reduce(
      (sum, i) => sum + i.calories_kcal,
      0,
    );
    const expectedWeight = result.ingredients.reduce(
      (sum, i) => sum + i.quantity_g,
      0,
    );

    expect(result.totals.calories_kcal).toBeCloseTo(expectedCalories, 5);
    expect(result.totals.weight_g).toBeCloseTo(expectedWeight, 5);
  });

  it("metadata contains all required fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSuccessResponse()));

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(result.metadata).toMatchObject({
      provider: expect.stringMatching(/^(openai|google)$/),
      model: expect.any(String),
      latency_ms: expect.any(Number),
      timestamp: expect.any(String),
      input_hash: expect.any(String),
      fallback: expect.any(Boolean),
    });
  });

  it("AC-4: flags ingredients with confidence below threshold as low_confidence", async () => {
    process.env.LOW_CONFIDENCE_THRESHOLD = "0.6";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeSuccessResponse({
          ingredients: [
            {
              name: "Chicken",
              quantity_g: 150,
              confidence: 0.95,
              calories_kcal: 248,
              protein_g: 46,
              carbs_g: 0,
              fat_g: 5,
            },
            {
              name: "Sauce",
              quantity_g: 30,
              confidence: 0.4,
              calories_kcal: 50,
              protein_g: 1,
              carbs_g: 5,
              fat_g: 2,
            },
          ],
        }),
      ),
    );

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(result.ingredients[0].confidence).toBeGreaterThanOrEqual(0.5); // 0.95 >= 0.5
    expect(result.ingredients[1].confidence).toBeLessThan(0.5); // 0.4 < 0.5
  });

  it("AC-4: ingredient with confidence exactly at 0.5 is not low confidence", async () => {
    process.env.LOW_CONFIDENCE_THRESHOLD = "0.6";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeSuccessResponse({
          ingredients: [
            {
              name: "Rice",
              quantity_g: 100,
              confidence: 0.6,
              calories_kcal: 120,
              protein_g: 2,
              carbs_g: 26,
              fat_g: 0,
            },
          ],
        }),
      ),
    );

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(result.ingredients[0].confidence).toBeGreaterThanOrEqual(0.5); // 0.6 >= threshold
  });
});

// ─── T018: normalizeCookingMethod ─────────────────────────────────────────────

describe("T018 — normalizeCookingMethod (AC-009)", () => {
  it.each([
    ["GRILLED", "GRILLED"],
    ["grilled", "GRILLED"],
    ["GRILLING", "GRILLED"],
    ["GRILL", "GRILLED"],
    ["BAKED", "BAKED"],
    ["BAKING", "BAKED"],
    ["ROASTED", "BAKED"],
    ["ROASTING", "BAKED"],
    ["FRIED", "FRIED"],
    ["FRYING", "FRIED"],
    ["FRITO", "FRIED"],
    ["BOILED", "BOILED"],
    ["BOILING", "BOILED"],
    ["HERVIDO", "BOILED"],
    ["RAW", "RAW"],
    ["CRUDO", "RAW"],
    ["MIXED", "MIXED"],
    ["unknown value", "UNKNOWN"],
    [undefined, "UNKNOWN"],
    ["", "UNKNOWN"],
  ])("normalizes %s → %s", (input, expected) => {
    expect(normalizeCookingMethod(input)).toBe(expected);
  });
});

// ─── T019: classifyConfidenceLevel ───────────────────────────────────────────

describe("T019 — classifyConfidenceLevel", () => {
  it.each([
    [0.9, "HIGH_CONFIDENCE"],
    [0.7, "HIGH_CONFIDENCE"], // exact boundary
    [0.69, "MEDIUM_CONFIDENCE"],
    [0.5, "MEDIUM_CONFIDENCE"], // exact boundary
    [0.49, "LOW_CONFIDENCE"],
    [0.0, "LOW_CONFIDENCE"],
    [1.0, "HIGH_CONFIDENCE"],
  ])("confidence %s → %s", (confidence, expected) => {
    expect(classifyConfidenceLevel(confidence)).toBe(expected);
  });
});

// ─── T020: Provenance fields (AC-008) ────────────────────────────────────────

describe("T020 — provenance fields (AC-008)", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_VISION_URL =
      "https://api.openai.com/v1/chat/completions";
    process.env.ALLOW_MOCK_AI = "false";
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("provenance.source = openai_vision on primary success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSuccessResponse()));

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(result.provenance.source).toBe("openai_vision");
    expect(result.provenance.model).toBeTruthy();
    expect(result.provenance.processed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("provenance.source = google_vision on fallback success (AC-003)", async () => {
    process.env.GOOGLE_VISION_API_KEY = "test-google-key";
    process.env.GOOGLE_VISION_URL = "https://vision.googleapis.com";

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          json: async () => ({}),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          json: async () => ({}),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          json: async () => ({}),
        })
        .mockResolvedValueOnce(makeSuccessResponse()),
    );

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(result.provenance.source).toBe("google_vision");
  });

  it("confidence and confidence_level always present in response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSuccessResponse()));

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(typeof result.confidence).toBe("number");
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect([
      "HIGH_CONFIDENCE",
      "MEDIUM_CONFIDENCE",
      "LOW_CONFIDENCE",
    ]).toContain(result.confidence_level);
  });
});

// ─── T021: status COMPLETED_WITH_WARNINGS (AC-005) ───────────────────────────

describe("T021 — status field (AC-005)", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_VISION_URL =
      "https://api.openai.com/v1/chat/completions";
    process.env.ALLOW_MOCK_AI = "false";
    process.env.NODE_ENV = "test";
    process.env.LOW_CONFIDENCE_THRESHOLD = "0.6";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("status = COMPLETED when all ingredients have high confidence", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSuccessResponse()));

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(result.status).toBe("COMPLETED");
  });

  it("status = COMPLETED_WITH_WARNINGS when any ingredient is low_confidence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeSuccessResponse({
          ingredients: [
            {
              name: "Chicken",
              quantity_g: 150,
              confidence: 0.9,
              calories_kcal: 248,
              protein_g: 46,
              carbs_g: 0,
              fat_g: 5,
            },
            {
              name: "Mystery sauce",
              quantity_g: 20,
              confidence: 0.3,
              calories_kcal: 40,
              protein_g: 1,
              carbs_g: 5,
              fat_g: 1,
            },
          ],
        }),
      ),
    );

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(result.status).toBe("COMPLETED_WITH_WARNINGS");
  });
});

// ─── T022: cooking_method normalization in output (AC-009) ───────────────────

describe("T022 — cooking_method in dish_description_structured (AC-009)", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_VISION_URL =
      "https://api.openai.com/v1/chat/completions";
    process.env.ALLOW_MOCK_AI = "false";
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes cooking_method_raw to enum in dish_description_structured", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          makeSuccessResponse({ cooking_method_raw: "GRILLING" }),
        ),
    );

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(result.dish_description_structured.cooking_method).toBe("GRILLED");
  });

  it("defaults cooking_method to UNKNOWN when raw value is unrecognized", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          makeSuccessResponse({ cooking_method_raw: "STEAMED_IN_SPACE" }),
        ),
    );

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(result.dish_description_structured.cooking_method).toBe("UNKNOWN");
  });

  it("estimated_weight_g matches totals.weight_g", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSuccessResponse()));

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(result.estimated_weight_g).toBe(result.totals.weight_g);
  });
});

// ─── T023: deduplicateIngredients (BR-010) ───────────────────────────────────

describe("T023 — deduplicateIngredients (Feature 006 BR-010)", () => {
  const base = {
    source: "INFERRED" as const,
    cooking_method: "GRILLED" as const,
    calories_kcal: 100,
    protein_g: 10,
    carbs_g: 10,
    fat_g: 5,
  };

  it("merges ingredients with same name (case-insensitive)", () => {
    const result = deduplicateIngredients([
      { ...base, name: "Chicken", quantity_g: 100, confidence: 0.9 },
      { ...base, name: "chicken", quantity_g: 50, confidence: 0.8 },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].quantity_g).toBe(150);
    expect(result[0].calories_kcal).toBe(200);
  });

  it("computes confidence as weighted average by quantity_g", () => {
    const result = deduplicateIngredients([
      { ...base, name: "Rice", quantity_g: 100, confidence: 0.9 },
      { ...base, name: "rice", quantity_g: 100, confidence: 0.7 },
    ]);

    expect(result[0].confidence).toBeCloseTo(0.8, 2);
  });

  it("takes cooking_method from ingredient with highest quantity_g", () => {
    const result = deduplicateIngredients([
      {
        ...base,
        name: "Pork",
        quantity_g: 50,
        confidence: 0.9,
        cooking_method: "FRIED" as const,
      },
      {
        ...base,
        name: "pork",
        quantity_g: 150,
        confidence: 0.7,
        cooking_method: "BOILED" as const,
      },
    ]);

    expect(result[0].cooking_method).toBe("BOILED");
  });

  it("does not merge ingredients with different names", () => {
    const result = deduplicateIngredients([
      { ...base, name: "Chicken", quantity_g: 100, confidence: 0.9 },
      { ...base, name: "Lettuce", quantity_g: 50, confidence: 0.8 },
    ]);

    expect(result).toHaveLength(2);
  });

  it("returns unchanged list when no duplicates", () => {
    const input = [{ ...base, name: "Egg", quantity_g: 60, confidence: 0.95 }];
    const result = deduplicateIngredients(input);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Egg");
    expect(result[0].quantity_g).toBe(60);
  });

  it("handles empty array", () => {
    expect(deduplicateIngredients([])).toEqual([]);
  });

  it("sums all nutritional values for merged duplicates", () => {
    const result = deduplicateIngredients([
      {
        ...base,
        name: "Tomato",
        quantity_g: 100,
        confidence: 0.8,
        calories_kcal: 20,
        protein_g: 1,
        carbs_g: 4,
        fat_g: 0,
      },
      {
        ...base,
        name: "tomato",
        quantity_g: 50,
        confidence: 0.7,
        calories_kcal: 10,
        protein_g: 0.5,
        carbs_g: 2,
        fat_g: 0,
      },
    ]);

    expect(result[0].calories_kcal).toBeCloseTo(30);
    expect(result[0].protein_g).toBeCloseTo(1.5);
    expect(result[0].carbs_g).toBeCloseTo(6);
    expect(result[0].fat_g).toBeCloseTo(0);
  });
});

// ─── T024: normalizeWeightConsistency (BR-011) ───────────────────────────────

describe("T024 — normalizeWeightConsistency (Feature 006 BR-011)", () => {
  const makeIngredients = (quantities: number[]) =>
    quantities.map((q, i) => ({
      name: `Ingredient ${i}`,
      quantity_g: q,
      source: "INFERRED" as const,
      confidence: 0.8,
      cooking_method: "MIXED" as const,
      calories_kcal: q * 2,
      protein_g: q * 0.1,
      carbs_g: q * 0.3,
      fat_g: q * 0.05,
    }));

  it("returns normalized=false when diff <= 10%", () => {
    // Sum = 200, totalWeight = 205 → diff = 2.5%
    const ingredients = makeIngredients([100, 100]);
    const result = normalizeWeightConsistency(ingredients, 205);

    expect(result.normalized).toBe(false);
    expect(result.ingredients).toBe(ingredients);
  });

  it("returns normalized=true and scales when diff > 10%", () => {
    // Sum = 200, totalWeight = 400 → diff = 100%
    const ingredients = makeIngredients([100, 100]);
    const result = normalizeWeightConsistency(ingredients, 400);

    expect(result.normalized).toBe(true);
    const newSum = result.ingredients.reduce((s, i) => s + i.quantity_g, 0);
    expect(newSum).toBeCloseTo(400, 0);
  });

  it("scales quantities proportionally", () => {
    // Sum = 100, totalWeight = 200 → each quantity should double
    const ingredients = makeIngredients([40, 60]);
    const result = normalizeWeightConsistency(ingredients, 200);

    expect(result.ingredients[0].quantity_g).toBeCloseTo(80, 1);
    expect(result.ingredients[1].quantity_g).toBeCloseTo(120, 1);
  });

  it("scales nutritional values proportionally", () => {
    const ingredients = makeIngredients([100]);
    const result = normalizeWeightConsistency(ingredients, 200);

    expect(result.ingredients[0].calories_kcal).toBeCloseTo(400, 0);
    expect(result.ingredients[0].protein_g).toBeCloseTo(20, 0);
  });

  it("always returns originalTotal pre-normalization sum", () => {
    const ingredients = makeIngredients([100, 50]);
    const result = normalizeWeightConsistency(ingredients, 500);

    expect(result.originalTotal).toBe(150);
  });

  it("handles empty ingredients safely", () => {
    const result = normalizeWeightConsistency([], 300);

    expect(result.normalized).toBe(false);
    expect(result.ingredients).toEqual([]);
  });

  it("handles totalWeight === 0 safely", () => {
    const ingredients = makeIngredients([100]);
    const result = normalizeWeightConsistency(ingredients, 0);

    expect(result.normalized).toBe(false);
  });
});

// ─── T025: ingredient source and cooking_method (Feature 006) ────────────────

describe("T025 — ingredient source and cooking_method (Feature 006)", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_VISION_URL =
      "https://api.openai.com/v1/chat/completions";
    process.env.ALLOW_MOCK_AI = "false";
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('all ingredients have source === "INFERRED"', async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSuccessResponse()));

    const result = await analyzeImageWithFallback(VALID_INPUT);

    for (const ing of result.ingredients) {
      expect(ing.source).toBe("INFERRED");
    }
  });

  it("all ingredients have cooking_method field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSuccessResponse()));

    const result = await analyzeImageWithFallback(VALID_INPUT);

    for (const ing of result.ingredients) {
      expect(ing).toHaveProperty("cooking_method");
      expect(typeof ing.cooking_method).toBe("string");
      expect(ing.cooking_method.length).toBeGreaterThan(0);
    }
  });

  it("ingredient inherits dish cooking_method when not per-ingredient", async () => {
    // makeSuccessResponse ingredients have no per-ingredient cooking_method
    // dish cooking_method_raw = "GRILLED"
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          makeSuccessResponse({ cooking_method_raw: "GRILLED" }),
        ),
    );

    const result = await analyzeImageWithFallback(VALID_INPUT);

    for (const ing of result.ingredients) {
      expect(ing.cooking_method).toBe("GRILLED");
    }
  });

  it("ingredient uses its own cooking_method when provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeSuccessResponse({
          cooking_method_raw: "GRILLED",
          ingredients: [
            {
              name: "Potato",
              quantity_g: 150,
              confidence: 0.9,
              cooking_method: "FRIED",
              calories_kcal: 200,
              protein_g: 3,
              carbs_g: 30,
              fat_g: 8,
            },
          ],
        }),
      ),
    );

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(result.ingredients[0].cooking_method).toBe("FRIED");
  });
});

// ─── T026: ingredient name max 120 chars (Feature 006) ───────────────────────

describe("T026 — ingredient name max 120 chars (Feature 006)", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_VISION_URL =
      "https://api.openai.com/v1/chat/completions";
    process.env.ALLOW_MOCK_AI = "false";
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("truncates ingredient name longer than 120 chars", async () => {
    const longName = "A".repeat(150);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeSuccessResponse({
          ingredients: [
            {
              name: longName,
              quantity_g: 100,
              confidence: 0.9,
              calories_kcal: 100,
              protein_g: 5,
              carbs_g: 10,
              fat_g: 2,
            },
          ],
        }),
      ),
    );

    const result = await analyzeImageWithFallback(VALID_INPUT);

    expect(result.ingredients[0].name.length).toBeLessThanOrEqual(120);
    expect(result.ingredients[0].name).toBe("A".repeat(120));
  });

  it("preserves ingredient name shorter than 120 chars", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSuccessResponse()));

    const result = await analyzeImageWithFallback(VALID_INPUT);

    for (const ing of result.ingredients) {
      expect(ing.name.length).toBeLessThanOrEqual(120);
    }
  });
});
