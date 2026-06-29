/**
 * Feature 014 — Gestión de histórico de comidas
 * Integration tests for meal history: paginated listing, date editing,
 * image-edit rejection, hard delete, and ownership enforcement.
 *
 * Same pattern as meals.integration.test.ts: supertest + real Express app,
 * Prisma mocked via vi.spyOn. Error format: { timestamp, status, code, message, path }.
 */

import jwt from "jsonwebtoken";
import request from "supertest";
import { prisma } from "../lib/prisma";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function buildToken(userId: string): string {
  const secret = process.env.JWT_SECRET ?? "change-me";
  return jwt.sign({ sub: userId }, secret);
}

const TEST_USER_ID = "user-014-integration";
const OTHER_USER_ID = "user-014-other";
const MEAL_ID = "meal-014-abc-uuid";

/** Valid update payload for PUT (source enum is lowercase in UpdateMealPayloadSchema). */
const validUpdate = {
  ingredients: [
    {
      name: "Arroz blanco",
      quantity_g: 150,
      source: "manual",
      calories_kcal: 195,
      protein_g: 4.1,
      carbs_g: 43,
      fat_g: 0.4,
    },
  ],
  nutrition: {
    calories_kcal: 195,
    protein_g: 4.1,
    carbs_g: 43,
    fat_g: 0.4,
    total_weight_g: 150,
  },
  meal_date: "2026-06-10T09:00:00.000Z",
};

describe("Feature 014 — meal history integration", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "change-me";
    process.env.REDIS_URL = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── GET list — pagination mode (Cond. 1, 7) ──────────────────────────────────

  it("GET /api/v1/meals?limit=2 returns a paginated, owner-scoped collection with total", async () => {
    vi.spyOn(prisma.meal, "findMany").mockResolvedValue([
      {
        id: "m1",
        mealDate: new Date("2026-06-10T09:00:00.000Z"),
        status: "confirmed",
        createdAt: new Date("2026-06-10T09:00:00.000Z"),
        updatedAt: new Date("2026-06-10T09:00:00.000Z"),
        nutrition: {
          caloriesKcal: 195,
          proteinG: 4.1,
          carbsG: 43,
          fatG: 0.4,
          totalWeightG: 150,
        },
        image: { storageKey: "uploads/m1.jpg" },
      },
      {
        id: "m2",
        mealDate: new Date("2026-06-09T09:00:00.000Z"),
        status: "confirmed",
        createdAt: new Date("2026-06-09T09:00:00.000Z"),
        updatedAt: new Date("2026-06-09T09:00:00.000Z"),
        nutrition: null,
        image: null,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    vi.spyOn(prisma.meal, "count").mockResolvedValue(5);

    const { createApp } = await import("../app.js");
    const app = createApp();

    const response = await request(app)
      .get("/api/v1/meals?limit=2&offset=0")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      count: 2,
      total: 5,
      limit: 2,
      offset: 0,
    });
    expect(response.body.meals[0]).toMatchObject({
      meal_id: "m1",
      calories_kcal: 195,
      image: { storage_key: "uploads/m1.jpg" },
    });
    expect(response.body.meals[1].image).toBeNull();
  });

  // ── GET empty (Cond. 7) ──────────────────────────────────────────────────────

  it("GET /api/v1/meals?limit=10 returns an empty collection when the user has no meals", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(prisma.meal, "findMany").mockResolvedValue([] as any);
    vi.spyOn(prisma.meal, "count").mockResolvedValue(0);

    const { createApp } = await import("../app.js");
    const app = createApp();

    const response = await request(app)
      .get("/api/v1/meals?limit=10")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ count: 0, total: 0 });
    expect(response.body.meals).toEqual([]);
  });

  // ── PUT — edit meal date (Cond. 4 / BR-017) ──────────────────────────────────

  it("PUT /api/v1/meals/:id persists an edited meal_date", async () => {
    vi.spyOn(prisma.meal, "findUnique").mockResolvedValue({
      id: MEAL_ID,
      userId: TEST_USER_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const txMealUpdate = vi.fn().mockResolvedValue({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(prisma, "$transaction").mockImplementation(async (fn: any) =>
      fn({
        meal: { update: txMealUpdate },
        ingredient: {
          deleteMany: vi.fn().mockResolvedValue({}),
          createMany: vi.fn().mockResolvedValue({}),
        },
        nutritionalData: { upsert: vi.fn().mockResolvedValue({}) },
      }),
    );

    const { createApp } = await import("../app.js");
    const app = createApp();

    const response = await request(app)
      .put(`/api/v1/meals/${MEAL_ID}`)
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send(validUpdate);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ meal_id: MEAL_ID, status: "updated" });
    expect(txMealUpdate).toHaveBeenCalledWith({
      where: { id: MEAL_ID },
      data: { mealDate: new Date("2026-06-10T09:00:00.000Z") },
    });
  });

  // ── PUT — invalid date rejected (Cond. 4) ────────────────────────────────────

  it("PUT /api/v1/meals/:id rejects an invalid meal_date with 400", async () => {
    const { createApp } = await import("../app.js");
    const app = createApp();

    const response = await request(app)
      .put(`/api/v1/meals/${MEAL_ID}`)
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send({ ...validUpdate, meal_date: "not-a-date" });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
  });

  // ── PUT — image change rejected (Cond. 5 / BR-018) ───────────────────────────

  it("PUT /api/v1/meals/:id rejects an attempt to change the image with 400", async () => {
    const { createApp } = await import("../app.js");
    const app = createApp();

    const response = await request(app)
      .put(`/api/v1/meals/${MEAL_ID}`)
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send({ ...validUpdate, image_url: "uploads/new-image.jpg" });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    expect(response.body.message).toMatch(/image/i);
  });

  // ── PUT — ownership (Invariant 1) ────────────────────────────────────────────

  it("PUT /api/v1/meals/:id returns 403 when the meal belongs to another user", async () => {
    vi.spyOn(prisma.meal, "findUnique").mockResolvedValue({
      id: MEAL_ID,
      userId: OTHER_USER_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const { createApp } = await import("../app.js");
    const app = createApp();

    const response = await request(app)
      .put(`/api/v1/meals/${MEAL_ID}`)
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send(validUpdate);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  // ── DELETE — hard delete (Cond. 6) ───────────────────────────────────────────

  it("DELETE /api/v1/meals/:id performs a hard delete", async () => {
    vi.spyOn(prisma.meal, "findUnique")
      .mockResolvedValueOnce({
        id: MEAL_ID,
        userId: TEST_USER_ID,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      .mockResolvedValueOnce({
        id: MEAL_ID,
        userId: TEST_USER_ID,
        image: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delSpy = vi
      .spyOn(prisma.meal, "delete")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValue({ id: MEAL_ID } as any);

    const { createApp } = await import("../app.js");
    const app = createApp();

    const response = await request(app)
      .delete(`/api/v1/meals/${MEAL_ID}`)
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ meal_id: MEAL_ID, status: "deleted" });
    expect(delSpy).toHaveBeenCalledWith({ where: { id: MEAL_ID } });
  });

  // ── DELETE — ownership (Invariant 1) ─────────────────────────────────────────

  it("DELETE /api/v1/meals/:id returns 403 when the meal belongs to another user", async () => {
    vi.spyOn(prisma.meal, "findUnique").mockResolvedValue({
      id: MEAL_ID,
      userId: OTHER_USER_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const { createApp } = await import("../app.js");
    const app = createApp();

    const response = await request(app)
      .delete(`/api/v1/meals/${MEAL_ID}`)
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });
});
