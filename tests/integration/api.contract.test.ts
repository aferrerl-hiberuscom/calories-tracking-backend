import jwt from "jsonwebtoken";
import request from "supertest";
import { prisma } from "../../src/lib/prisma";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function buildToken(userId: string): string {
  const secret = process.env.JWT_SECRET || "change-me";
  return jwt.sign({ sub: userId }, secret);
}

describe("API contract and security", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    process.env.JWT_SECRET = "change-me";
    process.env.REDIS_URL = "";
  });

  it("returns health status", async () => {
    const { createApp } = await import("../../src/app");
    const app = createApp();

    const response = await request(app).get("/api/v1/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("enforces auth on analyze-image", async () => {
    const { createApp } = await import("../../src/app");
    const app = createApp();

    const response = await request(app).post("/api/v1/analyze-image").send({});

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHORIZED");
  });

  it("returns standardized validation error payload", async () => {
    const { createApp } = await import("../../src/app");
    const app = createApp();

    const response = await request(app)
      .post("/api/v1/analyze-image")
      .set("Authorization", `Bearer ${buildToken("user-validation")}`)
      .send({ imageBase64: "", mimeType: "image/jpeg" });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
    expect(typeof response.body.timestamp).toBe("string");
    expect(response.body.path).toBe("/api/v1/analyze-image");
  });

  it("enforces analyze-image rate limit", async () => {
    const { createApp } = await import("../../src/app");
    const app = createApp();
    const token = buildToken("user-rate-limit");

    let lastStatus = 0;
    for (let i = 0; i < 21; i += 1) {
      const response = await request(app)
        .post("/api/v1/analyze-image")
        .set("Authorization", `Bearer ${token}`)
        .send({ imageBase64: "", mimeType: "image/jpeg" });
      lastStatus = response.status;
    }

    expect(lastStatus).toBe(429);
  });

  it("applies ownership scope on meal updates", async () => {
    vi.spyOn(prisma.meal, "findUnique").mockResolvedValue({
      id: "meal-owned-by-other",
      userId: "different-user",
    } as never);

    const { createApp } = await import("../../src/app");
    const app = createApp();
    const token = buildToken("user-owner");

    const response = await request(app)
      .put("/api/v1/meals/00000000-0000-0000-0000-000000000123")
      .set("Authorization", `Bearer ${token}`)
      .send({
        ingredients: [
          {
            name: "Rice",
            quantity_g: 100,
            source: "manual",
          },
        ],
        nutrition: {
          calories_kcal: 120,
          protein_g: 2,
          carbs_g: 26,
          fat_g: 0,
          total_weight_g: 100,
        },
      });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("FORBIDDEN");
  });
});
