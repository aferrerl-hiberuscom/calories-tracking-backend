// Feature ingredientes_frescos — nutrition reference search endpoint
// (contract 027 v1.3.0, AC-027-17). Patterns mirror dishes.routes.test.ts.

import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_USER_ID = "user-nutrition-test";

function buildToken(sub: string): string {
  return jwt.sign({ sub }, process.env.JWT_SECRET ?? "change-me");
}

const DB_ROWS = [
  {
    id: "nr-1",
    name: "Lechuga",
    category: "verduras",
    caloriesPer100g: 15,
    proteinPer100g: 1.4,
    carbsPer100g: 2.2,
    fatPer100g: 0.2,
    aliases: ["lechuga romana"],
  },
];

beforeEach(() => {
  vi.resetModules();
  process.env.JWT_SECRET = "change-me";
  process.env.REDIS_URL = "";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GET /api/v1/nutrition/reference", () => {
  it("returns per-100g macros for name/alias matches (AC-027-17)", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    const findSpy = vi
      .spyOn(p.nutritionalReference, "findMany")
      .mockResolvedValue(DB_ROWS as never);

    const res = await request(createApp())
      .get("/api/v1/nutrition/reference?q=lechuga")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toEqual({
      name: "Lechuga",
      calories_per_100g: 15,
      protein_per_100g: 1.4,
      carbs_per_100g: 2.2,
      fat_per_100g: 0.2,
    });
    expect(findSpy).toHaveBeenCalled();
  });

  it("returns 200 with an empty list when there is no match", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    vi.spyOn(p.nutritionalReference, "findMany").mockResolvedValue([] as never);

    const res = await request(createApp())
      .get("/api/v1/nutrition/reference?q=zzzzz")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it("rejects an empty query with 400", async () => {
    const { createApp } = await import("../../src/app");

    const res = await request(createApp())
      .get("/api/v1/nutrition/reference?q=")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_QUERY");
  });

  it("requires authentication (401)", async () => {
    const { createApp } = await import("../../src/app");
    const res = await request(createApp()).get(
      "/api/v1/nutrition/reference?q=lechuga",
    );
    expect(res.status).toBe(401);
  });
});
