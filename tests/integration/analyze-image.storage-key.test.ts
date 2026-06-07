/**
 * Feature 003 — analyze-image storage_key path tests (BT-004).
 *
 * Run in a dedicated file to avoid rate-limit state bleed from other
 * test files that exhaust the in-memory IP bucket in their own suite.
 */

import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as storageService from "../../src/services/storage.service";
import * as analyzeService from "../../src/services/analyze-image.service";

function buildToken(userId: string): string {
  const secret = process.env.JWT_SECRET || "change-me";
  return jwt.sign({ sub: userId }, secret);
}

describe("Feature 003 — analyze-image storage_key path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    process.env.JWT_SECRET = "change-me";
    process.env.REDIS_URL = "";
  });

  it("returns 400 when neither imageBase64 nor storage_key provided", async () => {
    const { createApp } = await import("../../src/app");
    const app = createApp();
    const token = buildToken("user-003-none");

    const response = await request(app)
      .post("/api/v1/analyze-image")
      .set("Authorization", `Bearer ${token}`)
      .send({ mimeType: "image/jpeg" });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
  });

  it("accepts storage_key and returns analysis result", async () => {
    const mockBase64 = "dGVzdA=="; // minimal valid-looking base64

    vi.spyOn(storageService, "fetchImageFromStorage").mockResolvedValue({
      base64: mockBase64,
      mimeType: "image/jpeg",
    });

    vi.spyOn(analyzeService, "analyzeImageWithFallback").mockResolvedValue({
      description: "Test dish",
      ingredients: [{ name: "Rice", quantity_g: 100, source: "visible" }],
      total_weight_g: 100,
      calories_kcal: 120,
      protein_g: 2,
      carbs_g: 26,
      fat_g: 0,
    });

    const { createApp } = await import("../../src/app");
    const app = createApp();
    const token = buildToken("user-003-storage-key");

    const response = await request(app)
      .post("/api/v1/analyze-image")
      .set("Authorization", `Bearer ${token}`)
      .send({
        storage_key: "user-003-storage-key/uuid.jpg",
        mimeType: "image/jpeg",
      });

    expect(response.status).toBe(200);
    expect(response.body.description).toBe("Test dish");
    expect(response.body.draft.ingredients).toHaveLength(1);
    expect(storageService.fetchImageFromStorage).toHaveBeenCalledWith(
      "user-003-storage-key/uuid.jpg",
    );
  });

  it("returns 503 when storage fetch fails for storage_key path", async () => {
    vi.spyOn(storageService, "fetchImageFromStorage").mockRejectedValue(
      new Error("Storage fetch failed (403): access denied"),
    );

    const { createApp } = await import("../../src/app");
    const app = createApp();
    const token = buildToken("user-003-storage-fail");

    const response = await request(app)
      .post("/api/v1/analyze-image")
      .set("Authorization", `Bearer ${token}`)
      .send({ storage_key: "user-003-storage-fail/missing.jpg" });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("STORAGE_UNAVAILABLE");
  });

  it("still accepts imageBase64 path for backward compat", async () => {
    const mockBase64 = "dGVzdA=="; // "test" in base64

    vi.spyOn(analyzeService, "analyzeImageWithFallback").mockResolvedValue({
      description: "Base64 test dish",
      ingredients: [],
      total_weight_g: 0,
      calories_kcal: 0,
      protein_g: 0,
      carbs_g: 0,
      fat_g: 0,
    });

    const { createApp } = await import("../../src/app");
    const app = createApp();
    const token = buildToken("user-003-base64-compat");

    const response = await request(app)
      .post("/api/v1/analyze-image")
      .set("Authorization", `Bearer ${token}`)
      .send({ imageBase64: mockBase64, mimeType: "image/jpeg" });

    expect(response.status).toBe(200);
    expect(response.body.description).toBe("Base64 test dish");
  });
});
