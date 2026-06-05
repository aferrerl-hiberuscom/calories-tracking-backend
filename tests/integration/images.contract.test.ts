/**
 * Contract and security tests for the image management feature.
 * Covers AC-003 (signed upload URL endpoint), AC-006/AC-012 (ownership,
 * access control), and AC-007 (cascade deletion endpoint auth).
 */

import jwt from "jsonwebtoken";
import request from "supertest";
import { prisma } from "../../src/lib/prisma";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as storageService from "../../src/services/storage.service";

function buildToken(userId: string): string {
  const secret = process.env.JWT_SECRET || "change-me";
  return jwt.sign({ sub: userId }, secret);
}

describe("Images API contract and security", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    process.env.JWT_SECRET = "change-me";
    process.env.REDIS_URL = "";
  });

  // --- AC-003: Signed upload URL endpoint ---

  describe("POST /api/v1/images/upload-url", () => {
    it("enforces auth — returns 401 without token", async () => {
      const { createApp } = await import("../../src/app");
      const app = createApp();

      const response = await request(app)
        .post("/api/v1/images/upload-url")
        .send({ mime_type: "image/jpeg", size_bytes: 1024 });

      expect(response.status).toBe(401);
      expect(response.body.code).toBe("UNAUTHORIZED");
    });

    it("returns 400 for unsupported MIME type", async () => {
      const { createApp } = await import("../../src/app");
      const app = createApp();
      const token = buildToken("user-mime-test");

      const response = await request(app)
        .post("/api/v1/images/upload-url")
        .set("Authorization", `Bearer ${token}`)
        .send({ mime_type: "image/gif", size_bytes: 1024 });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when image exceeds 5MB size limit", async () => {
      const { createApp } = await import("../../src/app");
      const app = createApp();
      const token = buildToken("user-size-test");

      const response = await request(app)
        .post("/api/v1/images/upload-url")
        .set("Authorization", `Bearer ${token}`)
        .send({ mime_type: "image/jpeg", size_bytes: 6 * 1024 * 1024 });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
    });

    it("returns signed upload URL for valid authenticated request", async () => {
      vi.spyOn(storageService, "getSignedUploadUrl").mockResolvedValue({
        storageKey: "user-abc/uuid.jpg",
        uploadUrl: "https://storage.example.com/signed-upload",
        token: "tok",
      });

      const { createApp } = await import("../../src/app");
      const app = createApp();
      const token = buildToken("user-abc");

      const response = await request(app)
        .post("/api/v1/images/upload-url")
        .set("Authorization", `Bearer ${token}`)
        .send({ mime_type: "image/jpeg", size_bytes: 1024 });

      expect(response.status).toBe(201);
      expect(response.body.storage_key).toBe("user-abc/uuid.jpg");
      expect(typeof response.body.upload_url).toBe("string");
      expect(response.body.expires_in).toBe(300);
    });

    it("returns 503 when storage service is unavailable", async () => {
      vi.spyOn(storageService, "getSignedUploadUrl").mockRejectedValue(
        new Error("Storage not configured"),
      );

      const { createApp } = await import("../../src/app");
      const app = createApp();
      const token = buildToken("user-storage-fail");

      const response = await request(app)
        .post("/api/v1/images/upload-url")
        .set("Authorization", `Bearer ${token}`)
        .send({ mime_type: "image/jpeg", size_bytes: 1024 });

      expect(response.status).toBe(503);
      expect(response.body.code).toBe("STORAGE_UNAVAILABLE");
    });
  });

  // --- AC-006 / AC-012: Ownership and access control ---

  describe("GET /api/v1/images/:mealId/view-url", () => {
    it("enforces auth — returns 401 without token", async () => {
      const { createApp } = await import("../../src/app");
      const app = createApp();

      const response = await request(app).get(
        "/api/v1/images/00000000-0000-0000-0000-000000000001/view-url",
      );

      expect(response.status).toBe(401);
    });

    it("returns 403 when non-owner requests image view URL", async () => {
      vi.spyOn(prisma.meal, "findUnique").mockResolvedValue({
        id: "meal-1",
        userId: "owner-user",
        image: { storageKey: "owner-user/uuid.jpg" },
      } as never);

      const { createApp } = await import("../../src/app");
      const app = createApp();
      const token = buildToken("different-user");

      const response = await request(app)
        .get("/api/v1/images/meal-1/view-url")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("FORBIDDEN");
    });

    it("returns signed view URL for image owner", async () => {
      vi.spyOn(prisma.meal, "findUnique").mockResolvedValue({
        id: "meal-2",
        userId: "owner-user-2",
        image: { storageKey: "owner-user-2/uuid.jpg" },
      } as never);
      vi.spyOn(storageService, "getSignedViewUrl").mockResolvedValue(
        "https://storage.example.com/signed-view",
      );

      const { createApp } = await import("../../src/app");
      const app = createApp();
      const token = buildToken("owner-user-2");

      const response = await request(app)
        .get("/api/v1/images/meal-2/view-url")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.view_url).toBe(
        "https://storage.example.com/signed-view",
      );
      expect(response.body.expires_in).toBe(3600);
    });

    it("returns 404 when meal has no associated image", async () => {
      vi.spyOn(prisma.meal, "findUnique").mockResolvedValue({
        id: "meal-no-image",
        userId: "user-no-img",
        image: null,
      } as never);

      const { createApp } = await import("../../src/app");
      const app = createApp();
      const token = buildToken("user-no-img");

      const response = await request(app)
        .get("/api/v1/images/meal-no-image/view-url")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(404);
    });
  });

  // --- AC-007: Cascade deletion invokes storage delete ---

  describe("DELETE /api/v1/meals/:id cascade storage", () => {
    it("calls deleteImage when meal with image is deleted", async () => {
      const deleteImageSpy = vi
        .spyOn(storageService, "deleteImage")
        .mockResolvedValue(undefined);

      vi.spyOn(prisma.meal, "findUnique")
        .mockResolvedValueOnce({
          id: "meal-with-image",
          userId: "user-cascade",
        } as never)
        .mockResolvedValueOnce({
          id: "meal-with-image",
          userId: "user-cascade",
          image: { storageKey: "user-cascade/image.jpg" },
        } as never);

      vi.spyOn(prisma.meal, "delete").mockResolvedValue({
        id: "meal-with-image",
      } as never);

      const { createApp } = await import("../../src/app");
      const app = createApp();
      const token = buildToken("user-cascade");

      const response = await request(app)
        .delete("/api/v1/meals/meal-with-image")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("deleted");

      // Allow the fire-and-forget void deleteImage to resolve
      await new Promise((r) => setTimeout(r, 50));
      expect(deleteImageSpy).toHaveBeenCalledWith("user-cascade/image.jpg");
    });
  });
});
