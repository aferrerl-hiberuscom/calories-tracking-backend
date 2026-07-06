/**
 * TASK-013-12: Integration tests for POST /api/v1/meals
 *
 * Uses supertest with the real Express app. Prisma is mocked via vi.spyOn
 * (same pattern as meals.persistence.test.ts).
 *
 * Error response format asserted: { timestamp, status, code, message, path }
 * (actual errorHandler format — NOT { error: { code, message } }).
 *
 * Note: The existing persistence test has `expect(response.body.status).toBe("created")`
 * but the controller emits `"confirmed"`. These tests assert against the ACTUAL
 * controller implementation (status: "confirmed").
 */

import jwt from "jsonwebtoken";
import request from "supertest";
import { prisma } from "../lib/prisma";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildToken(userId: string): string {
  const secret = process.env.JWT_SECRET ?? "change-me";
  return jwt.sign({ sub: userId }, secret);
}

const TEST_USER_ID = "user-013-integration";
const MOCK_MEAL_ID = "meal-013-abc-uuid";

/** Minimal valid payload that passes validateMealPayload */
const validPayload = {
  image_url: "uploads/test-013.jpg",
  // Evolution ui_redesign_brote (013 v2.0.0): dish name is required.
  name: "Arroz blanco",
  meal_date: "2026-06-05T12:00:00.000Z",
  total_weight_g: 150,
  calories_kcal: 195,
  protein_g: 4.1,
  carbs_g: 43,
  fat_g: 0.4,
  ingredients: [
    {
      name: "Arroz blanco",
      quantity_g: 150,
      source: "VISIBLE",
      calories_kcal: 195,
      protein_g: 4.1,
      carbs_g: 43,
      fat_g: 0.4,
      confidence: 0.9,
      cooking_method: "hervido",
    },
  ],
};

/** Configure prisma.$transaction to simulate a successful meal creation */
function mockSuccessfulTransaction(mealId = MOCK_MEAL_ID) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(prisma, "$transaction").mockImplementation(async (fn: any) => {
    return fn({
      meal: { create: vi.fn().mockResolvedValue({ id: mealId }) },
      ingredient: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      nutritionalData: { create: vi.fn().mockResolvedValue({}) },
      image: { create: vi.fn().mockResolvedValue({}) },
    });
  });
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("POST /api/v1/meals — Feature 013 integration", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "change-me";
    process.env.REDIS_URL = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 201 success ─────────────────────────────────────────────────────────────

  it("returns 201 with { meal_id, status: 'confirmed' } for a valid payload and valid JWT", async () => {
    mockSuccessfulTransaction(MOCK_MEAL_ID);

    const { createApp } = await import("../app.js");
    const app = createApp();

    const response = await request(app)
      .post("/api/v1/meals")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send(validPayload);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      meal_id: expect.any(String),
      status: "confirmed",
    });
    expect(response.body.meal_id).toBe(MOCK_MEAL_ID);
  });

  // ── 401 — missing Authorization header ──────────────────────────────────────

  it("returns 401 with standard error format when Authorization header is missing", async () => {
    const { createApp } = await import("../app.js");
    const app = createApp();

    const response = await request(app)
      .post("/api/v1/meals")
      .send(validPayload);

    expect(response.status).toBe(401);
    // Actual error format from errorHandler: { timestamp, status, code, message, path }
    expect(response.body).toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
      message: expect.any(String),
      path: "/api/v1/meals",
    });
    expect(typeof response.body.timestamp).toBe("string");
  });

  // ── 401 — invalid JWT ────────────────────────────────────────────────────────

  it("returns 401 with standard error format when JWT is invalid", async () => {
    const { createApp } = await import("../app.js");
    const app = createApp();

    const response = await request(app)
      .post("/api/v1/meals")
      .set("Authorization", "Bearer not-a-valid-jwt-token")
      .send(validPayload);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
      message: expect.any(String),
      path: "/api/v1/meals",
    });
    expect(typeof response.body.timestamp).toBe("string");
  });

  // ── 400 — missing ingredients ────────────────────────────────────────────────

  it("returns 400 with standard error format when ingredients array is missing", async () => {
    const { createApp } = await import("../app.js");
    const app = createApp();

    const badPayload = {
      image_url: "uploads/test.jpg",
      meal_date: "2026-06-05T12:00:00.000Z",
      total_weight_g: 0,
      calories_kcal: 0,
      protein_g: 0,
      carbs_g: 0,
      fat_g: 0,
      // ingredients intentionally omitted
    };

    const response = await request(app)
      .post("/api/v1/meals")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send(badPayload);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      message: expect.any(String),
      path: "/api/v1/meals",
    });
    expect(typeof response.body.timestamp).toBe("string");
  });

  // ── 400 — ingredient name > 120 chars ────────────────────────────────────────

  it("returns 400 when an ingredient name exceeds 120 characters", async () => {
    const { createApp } = await import("../app.js");
    const app = createApp();

    const longNameIngredient = {
      ...validPayload.ingredients[0],
      name: "x".repeat(121),
    };
    const badPayload = {
      ...validPayload,
      ingredients: [longNameIngredient],
    };

    const response = await request(app)
      .post("/api/v1/meals")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send(badPayload);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
  });

  // ── 500 — Prisma transaction failure ─────────────────────────────────────────

  it("returns 500 with standard error format when prisma transaction throws", async () => {
    vi.spyOn(prisma, "$transaction").mockRejectedValue(
      new Error("DB connection lost"),
    );

    const { createApp } = await import("../app.js");
    const app = createApp();

    const response = await request(app)
      .post("/api/v1/meals")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send(validPayload);

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
      message: expect.any(String),
      path: "/api/v1/meals",
    });
    expect(typeof response.body.timestamp).toBe("string");
  });
});
