/**
 * Contract tests for feature 022 — user provisioning and profile.
 * Covers AC "Esquema base"/"Provisión idempotente" (BR-029), "Unicidad"
 * (BR-028), and "No fuga de credenciales" (BR-030).
 */

import jwt from "jsonwebtoken";
import request from "supertest";
import { prisma } from "../../src/lib/prisma";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function buildToken(userId: string, email = "user@example.com"): string {
  const secret = process.env.JWT_SECRET || "change-me";
  return jwt.sign({ sub: userId, email }, secret);
}

describe("Users API contract and security", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    process.env.JWT_SECRET = "change-me";
    process.env.REDIS_URL = "";
  });

  describe("POST /api/v1/users/me", () => {
    it("enforces auth — returns 401 without token", async () => {
      const { createApp } = await import("../../src/app");
      const app = createApp();

      const response = await request(app).post("/api/v1/users/me").send({});

      expect(response.status).toBe(401);
      expect(response.body.code).toBe("UNAUTHORIZED");
    });

    it("provisions a new user on first call — 201 (BR-029)", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue(null);
      const createSpy = vi.spyOn(prisma.user, "create").mockResolvedValue({
        id: "user-new",
        email: "new@example.com",
        createdAt: new Date("2026-07-01T00:00:00Z"),
      } as never);

      const { createApp } = await import("../../src/app");
      const app = createApp();
      const token = buildToken("user-new", "new@example.com");

      const response = await request(app)
        .post("/api/v1/users/me")
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        id: "user-new",
        email: "new@example.com",
      });
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { id: "user-new", email: "new@example.com" },
        }),
      );
    });

    it("is idempotent on repeat calls — 200, no duplicate creation (BR-029)", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
        id: "user-existing",
        email: "existing@example.com",
        createdAt: new Date("2026-06-01T00:00:00Z"),
      } as never);
      const createSpy = vi.spyOn(prisma.user, "create");

      const { createApp } = await import("../../src/app");
      const app = createApp();
      const token = buildToken("user-existing", "existing@example.com");

      const response = await request(app)
        .post("/api/v1/users/me")
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: "user-existing",
        email: "existing@example.com",
      });
      expect(createSpy).not.toHaveBeenCalled();
    });

    it("rejects a colliding email with 409 (BR-028)", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue(null);
      const conflict = Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
        clientVersion: "5.0.0",
        meta: { target: ["email"] },
      });
      vi.spyOn(prisma.user, "create").mockRejectedValue(conflict);

      const { createApp } = await import("../../src/app");
      const app = createApp();
      const token = buildToken("user-colliding", "taken@example.com");

      const response = await request(app)
        .post("/api/v1/users/me")
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(response.status).toBe(409);
      expect(response.body.code).toBe("CONFLICT");
    });

    it("never includes credential material in the response (BR-030)", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue(null);
      vi.spyOn(prisma.user, "create").mockResolvedValue({
        id: "user-secure",
        email: "secure@example.com",
        createdAt: new Date("2026-07-01T00:00:00Z"),
        passwordHash: "should-never-leak",
      } as never);

      const { createApp } = await import("../../src/app");
      const app = createApp();
      const token = buildToken("user-secure", "secure@example.com");

      const response = await request(app)
        .post("/api/v1/users/me")
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(response.body.passwordHash).toBeUndefined();
      expect(response.body.password_hash).toBeUndefined();
      expect(Object.keys(response.body).sort()).toEqual(
        ["created_at", "email", "id"].sort(),
      );
    });
  });

  describe("GET /api/v1/users/me", () => {
    it("enforces auth — returns 401 without token", async () => {
      const { createApp } = await import("../../src/app");
      const app = createApp();

      const response = await request(app).get("/api/v1/users/me");

      expect(response.status).toBe(401);
      expect(response.body.code).toBe("UNAUTHORIZED");
    });

    it("returns 404 when the identity has not been provisioned yet", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue(null);

      const { createApp } = await import("../../src/app");
      const app = createApp();
      const token = buildToken("user-unprovisioned");

      const response = await request(app)
        .get("/api/v1/users/me")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(404);
      expect(response.body.code).toBe("NOT_FOUND");
    });

    it("returns the owner's profile without credential material (BR-030)", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
        id: "user-profile",
        email: "profile@example.com",
        createdAt: new Date("2026-05-01T00:00:00Z"),
        passwordHash: "should-never-leak",
      } as never);

      const { createApp } = await import("../../src/app");
      const app = createApp();
      const token = buildToken("user-profile", "profile@example.com");

      const response = await request(app)
        .get("/api/v1/users/me")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: "user-profile",
        email: "profile@example.com",
      });
      expect(response.body.passwordHash).toBeUndefined();
      expect(response.body.password_hash).toBeUndefined();
    });
  });
});
