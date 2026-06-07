/**
 * Feature 019 — analyze-image route tests (image_url contract).
 *
 * Tests the updated route that accepts { image_url, user_id } JSON body,
 * verifies ownership, and returns enriched metadata response.
 */

import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as storageService from "../../src/services/storage.service";
import * as analyzeService from "../../src/services/analyze-image.service";
import * as imageOwnership from "../../src/lib/image-ownership";
import { ApiError } from "../../src/middleware/api-error";
import type { AnalyzeOutput } from "../../src/services/analyze-image.service";

function buildToken(userId: string): string {
  const secret = process.env.JWT_SECRET || "change-me";
  return jwt.sign({ sub: userId }, secret);
}

// UUIDs are required by the route schema (user_id must be UUID)
const USER_UUID_1 = "00000000-0000-0000-0000-000000000001";
const USER_UUID_2 = "00000000-0000-0000-0000-000000000002"; // different user

const SUPABASE_IMAGE_URL =
  "https://project.supabase.co/storage/v1/object/public/meal-images/user-abc/uuid.jpg";

const USER_UUID_MISS_URL = "00000000-0000-0000-0000-000000000010";
const USER_UUID_MISS_UID = "00000000-0000-0000-0000-000000000011";
const USER_UUID_OWN_FAIL = "00000000-0000-0000-0000-000000000020";
const USER_UUID_SUCCESS = "00000000-0000-0000-0000-000000000030";
const USER_UUID_STORE_FAIL = "00000000-0000-0000-0000-000000000040";

const MOCK_ANALYZE_OUTPUT: AnalyzeOutput = {
  dish_description: "Test dish",
  ingredients: [
    {
      name: "Rice",
      quantity_g: 100,
      source: "ai",
      confidence: 0.9,
      calories_kcal: 120,
      protein_g: 2,
      carbs_g: 26,
      fat_g: 0,
    },
  ],
  totals: {
    weight_g: 100,
    calories_kcal: 120,
    protein_g: 2,
    carbs_g: 26,
    fat_g: 0,
  },
  metadata: {
    provider: "openai",
    model: "gpt-4o",
    latency_ms: 1200,
    timestamp: new Date().toISOString(),
    input_hash: "abc123",
    fallback: false,
    confidence_scores: [0.9],
  },
};

describe("Feature 019 — analyze-image route (image_url)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    process.env.JWT_SECRET = "change-me";
    process.env.REDIS_URL = "";
  });

  it("returns 400 when image_url is missing", async () => {
    const { createApp } = await import("../../src/app");
    const app = createApp();
    const token = buildToken(USER_UUID_MISS_URL);

    const response = await request(app)
      .post("/api/v1/analyze-image")
      .set("Authorization", `Bearer ${token}`)
      .send({ user_id: USER_UUID_MISS_URL });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when user_id is missing", async () => {
    const { createApp } = await import("../../src/app");
    const app = createApp();
    const token = buildToken(USER_UUID_MISS_UID);

    const response = await request(app)
      .post("/api/v1/analyze-image")
      .set("Authorization", `Bearer ${token}`)
      .send({ image_url: SUPABASE_IMAGE_URL });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 401 when JWT is missing", async () => {
    const { createApp } = await import("../../src/app");
    const app = createApp();

    const response = await request(app)
      .post("/api/v1/analyze-image")
      .send({ image_url: SUPABASE_IMAGE_URL, user_id: USER_UUID_1 });

    expect(response.status).toBe(401);
  });

  it("returns 403 when user_id does not match JWT subject", async () => {
    const { createApp } = await import("../../src/app");
    const app = createApp();
    const token = buildToken(USER_UUID_1);

    const response = await request(app)
      .post("/api/v1/analyze-image")
      .set("Authorization", `Bearer ${token}`)
      .send({ image_url: SUPABASE_IMAGE_URL, user_id: USER_UUID_2 });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("FORBIDDEN_OWNERSHIP");
  });

  it("returns 403 when image ownership verification fails", async () => {
    vi.spyOn(imageOwnership, "extractStorageKey").mockReturnValue("some-key");
    vi.spyOn(imageOwnership, "verifyImageOwnership").mockRejectedValue(
      new ApiError(
        403,
        "FORBIDDEN_OWNERSHIP",
        "You do not have access to this image",
      ),
    );

    const { createApp } = await import("../../src/app");
    const app = createApp();
    const token = buildToken(USER_UUID_OWN_FAIL);

    const response = await request(app)
      .post("/api/v1/analyze-image")
      .set("Authorization", `Bearer ${token}`)
      .send({ image_url: SUPABASE_IMAGE_URL, user_id: USER_UUID_OWN_FAIL });

    expect(response.status).toBe(403);
  });

  it("accepts image_url and returns enriched metadata response", async () => {
    const mockBase64 = "dGVzdA==";

    vi.spyOn(imageOwnership, "extractStorageKey").mockReturnValue(
      "some/uuid.jpg",
    );
    vi.spyOn(imageOwnership, "verifyImageOwnership").mockResolvedValue(
      undefined,
    );
    vi.spyOn(storageService, "fetchImageFromStorage").mockResolvedValue({
      base64: mockBase64,
      mimeType: "image/jpeg",
    });
    vi.spyOn(analyzeService, "analyzeImageWithFallback").mockResolvedValue(
      MOCK_ANALYZE_OUTPUT,
    );

    const { createApp } = await import("../../src/app");
    const app = createApp();
    const token = buildToken(USER_UUID_SUCCESS);

    const response = await request(app)
      .post("/api/v1/analyze-image")
      .set("Authorization", `Bearer ${token}`)
      .send({ image_url: SUPABASE_IMAGE_URL, user_id: USER_UUID_SUCCESS });

    expect(response.status).toBe(200);
    expect(response.body.dish_description).toBe("Test dish");
    expect(response.body.ingredients).toHaveLength(1);
    expect(response.body.totals).toMatchObject({
      weight_g: 100,
      calories_kcal: 120,
    });
    expect(response.body.metadata).toMatchObject({
      provider: "openai",
      fallback: false,
      input_hash: "abc123",
    });
  });

  it("returns 503 when storage fetch fails", async () => {
    vi.spyOn(imageOwnership, "extractStorageKey").mockReturnValue(
      "some/key.jpg",
    );
    vi.spyOn(imageOwnership, "verifyImageOwnership").mockResolvedValue(
      undefined,
    );
    vi.spyOn(storageService, "fetchImageFromStorage").mockRejectedValue(
      new Error("Storage fetch failed (403): access denied"),
    );

    const { createApp } = await import("../../src/app");
    const app = createApp();
    const token = buildToken(USER_UUID_STORE_FAIL);

    const response = await request(app)
      .post("/api/v1/analyze-image")
      .set("Authorization", `Bearer ${token}`)
      .send({ image_url: SUPABASE_IMAGE_URL, user_id: USER_UUID_STORE_FAIL });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("STORAGE_UNAVAILABLE");
  });
});
