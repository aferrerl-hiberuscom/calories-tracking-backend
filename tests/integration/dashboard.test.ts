import jwt from "jsonwebtoken";
import request from "supertest";
import { prisma } from "../../src/lib/prisma";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function buildToken(userId: string): string {
  const secret = process.env.JWT_SECRET || "change-me";
  return jwt.sign({ sub: userId }, secret);
}

const USER_A = "user-a-dashboard";

function confirmedMeal(
  nutrition: Partial<{
    caloriesKcal: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
  }>,
) {
  return {
    id: "m",
    userId: USER_A,
    mealDate: new Date("2026-06-15T12:00:00Z"),
    status: "confirmed",
    createdAt: new Date(),
    updatedAt: new Date(),
    nutrition: {
      caloriesKcal: 0,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      totalWeightG: 0,
      ...nutrition,
    },
  };
}

describe("GET /api/v1/dashboard", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "change-me";
    process.env.REDIS_URL = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 401 without auth token", async () => {
    const { createApp } = await import("../../src/app");
    const response = await request(createApp()).get("/api/v1/dashboard");
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHORIZED");
  });

  it("returns 400 on invalid period", async () => {
    const { createApp } = await import("../../src/app");
    const response = await request(createApp())
      .get("/api/v1/dashboard")
      .set("Authorization", `Bearer ${buildToken(USER_A)}`)
      .query({ period: "yearly" });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 on invalid timezone", async () => {
    const { createApp } = await import("../../src/app");
    const response = await request(createApp())
      .get("/api/v1/dashboard")
      .set("Authorization", `Bearer ${buildToken(USER_A)}`)
      .query({ period: "daily", tz: "Mars/Phobos" });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
  });

  it("aggregates kcal + macros from the user's confirmed meals (AC-001)", async () => {
    vi.spyOn(prisma.meal, "findMany").mockResolvedValue([
      confirmedMeal({ caloriesKcal: 500, proteinG: 30, carbsG: 60, fatG: 10 }),
      confirmedMeal({ caloriesKcal: 250, proteinG: 12, carbsG: 20, fatG: 8 }),
    ] as never);

    const { createApp } = await import("../../src/app");
    const response = await request(createApp())
      .get("/api/v1/dashboard")
      .set("Authorization", `Bearer ${buildToken(USER_A)}`)
      .query({ period: "daily" });

    expect(response.status).toBe(200);
    expect(response.body.calories_kcal).toBe(750);
    expect(response.body.protein_g).toBe(42);
    expect(response.body.carbs_g).toBe(80);
    expect(response.body.fat_g).toBe(18);
    expect(response.body.meal_count).toBe(2);
  });

  it("returns zeros + 200 for an empty period, not an error (AC-003)", async () => {
    vi.spyOn(prisma.meal, "findMany").mockResolvedValue([] as never);

    const { createApp } = await import("../../src/app");
    const response = await request(createApp())
      .get("/api/v1/dashboard")
      .set("Authorization", `Bearer ${buildToken(USER_A)}`)
      .query({ period: "daily" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      calories_kcal: 0,
      protein_g: 0,
      carbs_g: 0,
      fat_g: 0,
      meal_count: 0,
    });
  });

  it("scopes the query to the authenticated user and confirmed meals only (AC-006 / BR-018)", async () => {
    const spy = vi
      .spyOn(prisma.meal, "findMany")
      .mockResolvedValue([] as never);

    const { createApp } = await import("../../src/app");
    await request(createApp())
      .get("/api/v1/dashboard")
      .set("Authorization", `Bearer ${buildToken(USER_A)}`)
      .query({ period: "daily" });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER_A, status: "confirmed" }),
      }),
    );
  });

  it("returns 429 when rate limit is exceeded for the same user", async () => {
    // Mock the RateLimiterMemory consume so it rejects on the very first call
    // (simulates the user already having exhausted 60 req/min).
    const { RateLimiterMemory } = await import("rate-limiter-flexible");
    vi.spyOn(RateLimiterMemory.prototype, "consume").mockRejectedValueOnce(
      // rate-limiter-flexible throws a RateLimiterRes (not an Error) on excess
      { remainingPoints: 0, msBeforeNext: 30_000 },
    );

    const { createApp } = await import("../../src/app");
    const response = await request(createApp())
      .get("/api/v1/dashboard")
      .set("Authorization", `Bearer ${buildToken(USER_A)}`)
      .query({ period: "daily" });

    expect(response.status).toBe(429);
    expect(response.body.code).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("evaluates the daily range in the user's timezone, not UTC (AC-009)", async () => {
    const spy = vi
      .spyOn(prisma.meal, "findMany")
      .mockResolvedValue([] as never);

    const { createApp } = await import("../../src/app");
    await request(createApp())
      .get("/api/v1/dashboard")
      .set("Authorization", `Bearer ${buildToken(USER_A)}`)
      .query({
        period: "daily",
        tz: "Europe/Madrid",
        date: "2026-06-15T10:00:00.000Z",
      });

    // Madrid (CEST +2) local day 2026-06-15 → UTC [22:00 prev day .. 21:59:59.999].
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          mealDate: {
            gte: new Date("2026-06-14T22:00:00.000Z"),
            lte: new Date("2026-06-15T21:59:59.999Z"),
          },
        }),
      }),
    );
  });
});
