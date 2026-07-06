/**
 * Evolution ui_redesign_brote — contract 001 v2.0.0 (registration).
 * Integration tests for POST /api/v1/auth/register with prisma mocked via
 * vi.spyOn (same pattern as meals.integration.test.ts).
 */

import request from "supertest";
import { prisma } from "../lib/prisma";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NEW_USER = { id: "user-register-001", email: "nuevo@example.com" };

function mockUserCreateSuccess() {
  vi.spyOn(prisma.user, "create").mockResolvedValue(NEW_USER as never);
  vi.spyOn(prisma.refreshToken, "create").mockResolvedValue({} as never);
}

describe("POST /api/v1/auth/register — contract 001 v2.0.0", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "change-me";
    process.env.REDIS_URL = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 201 with the login token envelope (auto-login)", async () => {
    mockUserCreateSuccess();
    const { createApp } = await import("../app.js");
    const app = createApp();

    const res = await request(app).post("/api/v1/auth/register").send({
      email: NEW_USER.email,
      password: "supersegura8",
      name: "Alfonso",
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ token_type: "Bearer" });
    expect(typeof res.body.access_token).toBe("string");
    expect(typeof res.body.refresh_token).toBe("string");
    expect(typeof res.body.expires_in).toBe("number");
    // name is persisted on the created user (A-001 / 022 provisioning)
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: NEW_USER.email,
          name: "Alfonso",
        }),
      }),
    );
  });

  it("accepts registration without name (optional field)", async () => {
    mockUserCreateSuccess();
    const { createApp } = await import("../app.js");
    const app = createApp();

    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ email: NEW_USER.email, password: "supersegura8" });

    expect(res.status).toBe(201);
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: null }),
      }),
    );
  });

  it("returns 409 CONFLICT when the email is already registered", async () => {
    vi.spyOn(prisma.user, "create").mockRejectedValue(
      Object.assign(new Error("unique constraint"), { code: "P2002" }),
    );
    const { createApp } = await import("../app.js");
    const app = createApp();

    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ email: "dup@example.com", password: "supersegura8" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "CONFLICT" });
  });

  it("returns 400 when the password is shorter than 8 characters", async () => {
    const { createApp } = await import("../app.js");
    const app = createApp();

    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ email: "corto@example.com", password: "corta" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("never persists the plain password (only a hash)", async () => {
    mockUserCreateSuccess();
    const { createApp } = await import("../app.js");
    const app = createApp();

    await request(app)
      .post("/api/v1/auth/register")
      .send({ email: NEW_USER.email, password: "supersegura8" });

    const createArgs = vi.mocked(prisma.user.create).mock.calls[0][0] as {
      data: { passwordHash?: string };
    };
    expect(createArgs.data.passwordHash).toBeDefined();
    expect(createArgs.data.passwordHash).not.toBe("supersegura8");
    expect(JSON.stringify(createArgs.data)).not.toContain("supersegura8");
  });
});
