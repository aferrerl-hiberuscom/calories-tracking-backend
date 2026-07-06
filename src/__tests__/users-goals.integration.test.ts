/**
 * Feature 025 (contract v1.0.0) + 022 v1.3 — nutrition goals and profile name.
 * Integration tests with prisma mocked via vi.spyOn.
 */

import jwt from "jsonwebtoken";
import request from "supertest";
import { prisma } from "../lib/prisma";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "user-025-test";

function buildToken(userId: string): string {
  const secret = process.env.JWT_SECRET ?? "change-me";
  return jwt.sign({ sub: userId, email: "goals@example.com" }, secret);
}

const STORED_GOAL = {
  id: "goal-1",
  userId: USER_ID,
  caloriesKcalTarget: 1800,
  proteinGTarget: 130,
  carbsGTarget: 180,
  fatGTarget: 60,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("GET /api/v1/users/me/goals — feature 025", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "change-me";
    process.env.REDIS_URL = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 with defaults and is_default=true when no row exists (RN-1, D-BROTE-07)", async () => {
    vi.spyOn(prisma.nutritionGoal, "findUnique").mockResolvedValue(null);
    const { createApp } = await import("../app.js");
    const app = createApp();

    const res = await request(app)
      .get("/api/v1/users/me/goals")
      .set("Authorization", `Bearer ${buildToken(USER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      calories_kcal_target: 2000,
      protein_g_target: 120,
      carbs_g_target: 220,
      fat_g_target: 65,
      is_default: true,
    });
  });

  it("returns the stored goals with is_default=false after the first edit", async () => {
    vi.spyOn(prisma.nutritionGoal, "findUnique").mockResolvedValue(
      STORED_GOAL as never,
    );
    const { createApp } = await import("../app.js");
    const app = createApp();

    const res = await request(app)
      .get("/api/v1/users/me/goals")
      .set("Authorization", `Bearer ${buildToken(USER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      calories_kcal_target: 1800,
      protein_g_target: 130,
      carbs_g_target: 180,
      fat_g_target: 60,
      is_default: false,
    });
  });

  it("returns 401 without a token", async () => {
    const { createApp } = await import("../app.js");
    const app = createApp();
    const res = await request(app).get("/api/v1/users/me/goals");
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/v1/users/me/goals — feature 025", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "change-me";
    process.env.REDIS_URL = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("upserts and returns the stored values with is_default=false", async () => {
    const upsertSpy = vi
      .spyOn(prisma.nutritionGoal, "upsert")
      .mockResolvedValue(STORED_GOAL as never);
    const { createApp } = await import("../app.js");
    const app = createApp();

    const res = await request(app)
      .put("/api/v1/users/me/goals")
      .set("Authorization", `Bearer ${buildToken(USER_ID)}`)
      .send({
        calories_kcal_target: 1800,
        protein_g_target: 130,
        carbs_g_target: 180,
        fat_g_target: 60,
      });

    expect(res.status).toBe(200);
    expect(res.body.is_default).toBe(false);
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } }),
    );
  });

  it.each([
    ["kcal below 1000", { calories_kcal_target: 999 }],
    ["kcal above 6000", { calories_kcal_target: 6001 }],
    ["negative macro", { protein_g_target: -1 }],
    ["non-integer", { carbs_g_target: 180.5 }],
  ])("returns 400 for %s (RN-2 bounds)", async (_label, override) => {
    const { createApp } = await import("../app.js");
    const app = createApp();

    const res = await request(app)
      .put("/api/v1/users/me/goals")
      .set("Authorization", `Bearer ${buildToken(USER_ID)}`)
      .send({
        calories_kcal_target: 1800,
        protein_g_target: 130,
        carbs_g_target: 180,
        fat_g_target: 60,
        ...override,
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("PUT /api/v1/users/me — display name (022 v1.3 / D-BROTE-02)", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "change-me";
    process.env.REDIS_URL = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates the name and returns the profile including it", async () => {
    vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
      id: USER_ID,
    } as never);
    vi.spyOn(prisma.user, "update").mockResolvedValue({
      id: USER_ID,
      email: "goals@example.com",
      name: "Alfonso",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
    } as never);
    const { createApp } = await import("../app.js");
    const app = createApp();

    const res = await request(app)
      .put("/api/v1/users/me")
      .set("Authorization", `Bearer ${buildToken(USER_ID)}`)
      .send({ name: "Alfonso" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: USER_ID, name: "Alfonso" });
  });

  it("returns 400 for an empty or too long name", async () => {
    const { createApp } = await import("../app.js");
    const app = createApp();

    const empty = await request(app)
      .put("/api/v1/users/me")
      .set("Authorization", `Bearer ${buildToken(USER_ID)}`)
      .send({ name: "" });
    expect(empty.status).toBe(400);

    const long = await request(app)
      .put("/api/v1/users/me")
      .set("Authorization", `Bearer ${buildToken(USER_ID)}`)
      .send({ name: "x".repeat(121) });
    expect(long.status).toBe(400);
  });
});
