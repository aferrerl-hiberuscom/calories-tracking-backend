// Integration tests for feature 007 — Estimate Quantities
// Tests POST /api/v1/meals/:mealId/estimate-quantities
// Tests PUT  /api/v1/meals/:mealId/ingredients/:ingredientId/quantity

import jwt from "jsonwebtoken";
import request from "supertest";
import { prisma } from "../../src/lib/prisma";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function buildToken(userId: string): string {
  const secret = process.env.JWT_SECRET ?? "change-me";
  return jwt.sign({ sub: userId }, secret);
}

const TEST_USER_ID = "user-007-test";
const OTHER_USER_ID = "user-007-other";

describe("POST /api/v1/meals/:mealId/estimate-quantities", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.JWT_SECRET = "change-me";
    process.env.REDIS_URL = "";
    process.env.OPENAI_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 401 without JWT", async () => {
    const { createApp } = await import("../../src/app");
    const app = createApp();

    const res = await request(app)
      .post("/api/v1/meals/some-meal-id/estimate-quantities")
      .send({ ingredients: [{ name: "arroz" }] });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("returns 400 with empty ingredients array", async () => {
    const { createApp } = await import("../../src/app");
    const app = createApp();
    const { prisma: p } = await import("../../src/lib/prisma");

    vi.spyOn(p.meal, "findUnique").mockResolvedValue({
      id: "meal-1",
      userId: TEST_USER_ID,
      mealDate: new Date(),
      status: "draft",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const res = await request(app)
      .post("/api/v1/meals/meal-1/estimate-quantities")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send({ ingredients: [] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PAYLOAD");
  });

  it("returns 404 when meal not found", async () => {
    const { createApp } = await import("../../src/app");
    const app = createApp();

    vi.spyOn(prisma.meal, "findUnique").mockResolvedValue(null);

    const res = await request(app)
      .post("/api/v1/meals/nonexistent/estimate-quantities")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send({
        image_url: "https://example.com/img.jpg",
        ingredients: [{ name: "pollo" }],
      });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("MEAL_NOT_FOUND");
  });

  it("returns 503 when OpenAI Vision fails", async () => {
    vi.doMock("../../src/integrations/openAIVisionClient.js", () => {
      class VisionApiError extends Error {
        constructor(msg: string) {
          super(msg);
          this.name = "VisionApiError";
        }
      }
      return {
        analyzePortions: vi.fn().mockRejectedValue(
          new VisionApiError("Vision API unavailable after 2 attempts"),
        ),
        VisionApiError,
      };
    });

    const { createApp } = await import("../../src/app");
    const app = createApp();
    const { prisma: p } = await import("../../src/lib/prisma.js");

    vi.spyOn(p.meal, "findUnique").mockResolvedValue({
      id: "meal-1",
      userId: TEST_USER_ID,
      mealDate: new Date(),
      status: "draft",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const res = await request(app)
      .post("/api/v1/meals/meal-1/estimate-quantities")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send({
        image_url: "https://example.com/img.jpg",
        ingredients: [{ name: "arroz" }, { name: "pollo" }],
      });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("VISION_API_UNAVAILABLE");
  });

  it("returns 200 with estimated ingredients on success", async () => {
    vi.doMock("../../src/integrations/openAIVisionClient.js", () => ({
      analyzePortions: vi.fn().mockResolvedValue([
        { name: "arroz", quantity_g: 180, confidence: 0.9, source: "INFERRED" },
        {
          name: "pollo",
          quantity_g: 120,
          confidence: 0.85,
          source: "INFERRED",
        },
      ]),
      VisionApiError: class extends Error {},
    }));

    const { createApp } = await import("../../src/app");
    const app = createApp();
    const { prisma: p } = await import("../../src/lib/prisma.js");

    vi.spyOn(p.meal, "findUnique").mockResolvedValue({
      id: "meal-1",
      userId: TEST_USER_ID,
      mealDate: new Date(),
      status: "draft",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    vi.spyOn(p, "$queryRaw").mockResolvedValue([]);
    vi.spyOn(p.ingredient, "deleteMany").mockResolvedValue({ count: 0 });
    vi.spyOn(p.ingredient, "createMany").mockResolvedValue({ count: 2 });

    const res = await request(app)
      .post("/api/v1/meals/meal-1/estimate-quantities")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send({
        image_url: "https://example.com/img.jpg",
        ingredients: [{ name: "arroz" }, { name: "pollo" }],
      });

    expect(res.status).toBe(200);
    expect(res.body.meal_id).toBe("meal-1");
    expect(Array.isArray(res.body.ingredients)).toBe(true);
    expect(typeof res.body.total_weight_g).toBe("number");
    expect(Array.isArray(res.body.warnings)).toBe(true);
  });
});

describe("PUT /api/v1/meals/:mealId/ingredients/:ingredientId/quantity", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.JWT_SECRET = "change-me";
    process.env.REDIS_URL = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 401 without JWT", async () => {
    const { createApp } = await import("../../src/app");
    const app = createApp();

    const res = await request(app)
      .put("/api/v1/meals/meal-1/ingredients/ing-1/quantity")
      .send({ quantity_g: 150 });

    expect(res.status).toBe(401);
  });

  it("returns 400 with quantity_g=0 (out of range)", async () => {
    const { createApp } = await import("../../src/app");
    const app = createApp();
    const { prisma: p } = await import("../../src/lib/prisma");

    vi.spyOn(p.meal, "findUnique").mockResolvedValue({
      id: "meal-1",
      userId: TEST_USER_ID,
      mealDate: new Date(),
      status: "draft",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const res = await request(app)
      .put("/api/v1/meals/meal-1/ingredients/ing-1/quantity")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send({ quantity_g: 0 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("QUANTITY_OUT_OF_RANGE");
  });

  it("returns 200 and source=MANUAL on valid update", async () => {
    const { createApp } = await import("../../src/app");
    const app = createApp();
    const { prisma: p } = await import("../../src/lib/prisma");

    vi.spyOn(p.meal, "findUnique").mockResolvedValue({
      id: "meal-1",
      userId: TEST_USER_ID,
      mealDate: new Date(),
      status: "draft",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    vi.spyOn(p.ingredient, "findUnique").mockResolvedValue({
      id: "ing-1",
      mealId: "meal-1",
      name: "arroz",
      quantityG: 100,
      source: "INFERRED",
      confidence: 0.8,
      quantitySuspicious: false,
      cookingMethod: null,
      caloriesKcal: 130,
      proteinG: 2.7,
      carbsG: 28,
      fatG: 0.3,
    } as never);

    vi.spyOn(p.ingredient, "update").mockResolvedValue({
      id: "ing-1",
      mealId: "meal-1",
      name: "arroz",
      quantityG: 150,
      source: "MANUAL",
      confidence: 1.0,
      quantitySuspicious: false,
      cookingMethod: null,
      caloriesKcal: 195,
      proteinG: 4.05,
      carbsG: 42,
      fatG: 0.45,
    } as never);

    const res = await request(app)
      .put("/api/v1/meals/meal-1/ingredients/ing-1/quantity")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send({ quantity_g: 150 });

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("MANUAL");
    expect(res.body.confidence).toBe(1);
    expect(res.body.quantity_g).toBe(150);
  });
});
