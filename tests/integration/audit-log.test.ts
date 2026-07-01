import request from "supertest";
import { prisma } from "../../src/lib/prisma";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No tests/setup.ts exists in this repo (no global console redirection),
// so console.log is spied directly here and restored per-test.

describe("Audit log emission (request-logger.ts)", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "change-me";
    process.env.REDIS_URL = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs exactly one structured line for a 401 request, with UNAUTHORIZED error_message", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { createApp } = await import("../../src/app");
    const app = createApp();

    const response = await request(app).get("/api/v1/meals");

    expect(response.status).toBe(401);
    expect(logSpy).toHaveBeenCalledTimes(1);

    const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(logged.status).toBe(401);
    expect(logged.endpoint).toBe("/api/v1/meals");
    expect(logged.user_id).toBeNull();
    expect(logged.error_message).toBe("UNAUTHORIZED");
  });

  it("logs exactly one line for a granted POST /api/v1/meals, with error_message null", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    vi.spyOn(prisma, "$transaction").mockImplementation(
      async (fn: (tx: unknown) => Promise<{ id: string }>) => {
        return fn({
          meal: { create: vi.fn().mockResolvedValue({ id: "audit-meal-001" }) },
          ingredient: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
          nutritionalData: { create: vi.fn().mockResolvedValue({}) },
          image: { create: vi.fn().mockResolvedValue({}) },
        });
      },
    );

    const { createApp } = await import("../../src/app");
    const app = createApp();
    const jwt = await import("jsonwebtoken");
    const token = jwt.sign({ sub: "user-audit-single" }, "change-me");

    const response = await request(app)
      .post("/api/v1/meals")
      .set("Authorization", `Bearer ${token}`)
      .send({
        image_url: "https://storage.example.com/uploads/audit-image.jpg",
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
            source: "INFERRED",
            confidence: 0.9,
            cooking_method: "hervido",
            calories_kcal: 195,
            protein_g: 4.1,
            carbs_g: 43,
            fat_g: 0.4,
          },
        ],
      });

    expect(response.status).toBe(201);
    // Regression check: previously the route-local auditLog middleware
    // double-emitted this log line alongside requestLogger.
    expect(logSpy).toHaveBeenCalledTimes(1);

    const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(logged.error_message).toBeNull();
  });

  it("never logs sensitive fields (image/token/authorization/body) — Invariant 3", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { createApp } = await import("../../src/app");
    const app = createApp();

    await request(app)
      .post("/api/v1/meals")
      .set("Authorization", "Bearer some-token-value")
      .send({ meal_date: "2026-06-05T12:00:00.000Z" });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const rawLine = logSpy.mock.calls[0][0] as string;

    expect(rawLine).not.toMatch(/"image"/i);
    expect(rawLine).not.toMatch(/"token"/i);
    expect(rawLine).not.toMatch(/"authorization"/i);
    expect(rawLine).not.toMatch(/"body"/i);
  });
});
