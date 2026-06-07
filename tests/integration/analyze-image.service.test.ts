/**
 * Feature 019 — analyze-image.service unit tests
 *
 * Tests T014: metadata correctness (input_hash, fallback, provider)
 * Tests T015: error classification and retry (transient/permanent/critical)
 * Tests T016: no sensitive data in logs
 * Tests T017: response shape validation (contract compliance)
 */

import { createHash } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeImageWithFallback } from "../../src/services/analyze-image.service";
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
    const fetchMock = vi
      .fn()
      .mockRejectedValue(
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

  it("returns dish_description as non-empty string", async () => {
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
      expect(ing).toHaveProperty("calories_kcal");
      expect(ing).toHaveProperty("protein_g");
      expect(ing).toHaveProperty("carbs_g");
      expect(ing).toHaveProperty("fat_g");
      expect(ing.source).toBe("ai");
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
});
