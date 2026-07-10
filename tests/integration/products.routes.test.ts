// Feature 026 — products routes integration tests (contract §3).
// Patterns mirror estimateQuantities.routes.test.ts: supertest against the
// app, prisma spies (no real DB writes), fetch stubbed for OFF, and the
// Gemini label client mocked at module level.

import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_USER_ID = "user-products-test";

function buildToken(sub: string): string {
  return jwt.sign({ sub }, process.env.JWT_SECRET ?? "change-me");
}

function offPayload(overrides: Record<string, unknown> = {}) {
  return {
    status: 1,
    product: {
      product_name: "Yogur natural",
      brands: "MarcaTest",
      nutriments: {
        "energy-kcal_100g": 61,
        proteins_100g: 3.5,
        carbohydrates_100g: 4.7,
        fat_100g: 3.3,
      },
      serving_quantity: "125",
      serving_size: "1 yogur (125 g)",
      ...overrides,
    },
  };
}

const DB_PRODUCT = {
  id: "prod-1",
  barcode: "8410100012345",
  name: "Yogur natural",
  brand: "MarcaTest",
  caloriesKcal100g: 61,
  proteinG100g: 3.5,
  carbsG100g: 4.7,
  fatG100g: 3.3,
  servingSizeG: 125,
  servingLabel: "1 yogur (125 g)",
  source: "OFF",
  verified: true,
  createdByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.resetModules();
  process.env.JWT_SECRET = "change-me";
  process.env.REDIS_URL = "";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GET /api/v1/products/:barcode", () => {
  it("returns 400 INVALID_BARCODE for malformed codes", async () => {
    const { createApp } = await import("../../src/app");
    const res = await request(createApp())
      .get("/api/v1/products/12AB")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_BARCODE");
  });

  it("returns 200 from own table without calling OFF (cache first)", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    vi.spyOn(p.product, "findUnique").mockResolvedValue(DB_PRODUCT as never);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await request(createApp())
      .get("/api/v1/products/8410100012345")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.barcode).toBe("8410100012345");
    expect(res.body.source).toBe("OFF");
    expect(res.body.verified).toBe(true);
    expect(res.body.created_by_user_id).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves via OFF, persists and returns 200 (UPC-A normalized)", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    vi.spyOn(p.product, "findUnique").mockResolvedValue(null as never);
    const createSpy = vi
      .spyOn(p.product, "create")
      .mockResolvedValue({ ...DB_PRODUCT, barcode: "0036000291452" } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => offPayload(),
      }),
    );

    const res = await request(createApp())
      .get("/api/v1/products/036000291452")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.barcode).toBe("0036000291452");
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          barcode: "0036000291452",
          source: "OFF",
          verified: true,
        }),
      }),
    );
  });

  it("returns 404 when OFF does not know the product", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    vi.spyOn(p.product, "findUnique").mockResolvedValue(null as never);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 0 }),
      }),
    );

    const res = await request(createApp())
      .get("/api/v1/products/8410100012345")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PRODUCT_NOT_FOUND");
  });

  it("treats OFF hits with incomplete essential macros as 404 (AC-026-06)", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    vi.spyOn(p.product, "findUnique").mockResolvedValue(null as never);
    const createSpy = vi.spyOn(p.product, "create");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () =>
          offPayload({
            nutriments: {
              // fat_100g missing → essential macros incomplete
              "energy-kcal_100g": 61,
              proteins_100g: 3.5,
              carbohydrates_100g: 4.7,
            },
          }),
      }),
    );

    const res = await request(createApp())
      .get("/api/v1/products/8410100012345")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(res.status).toBe(404);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const { createApp } = await import("../../src/app");
    const res = await request(createApp()).get(
      "/api/v1/products/8410100012345",
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/products", () => {
  it("creates a user product (201, verified=false)", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    vi.spyOn(p.product, "findUnique").mockResolvedValue(null as never);
    vi.spyOn(p.product, "create").mockResolvedValue({
      ...DB_PRODUCT,
      source: "USER_LABEL",
      verified: false,
      createdByUserId: TEST_USER_ID,
    } as never);

    const res = await request(createApp())
      .post("/api/v1/products")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send({
        barcode: "8410100012345",
        name: "Yogur natural",
        calories_kcal_100g: 61,
        protein_g_100g: 3.5,
        carbs_g_100g: 4.7,
        fat_g_100g: 3.3,
        serving_size_g: 125,
        source: "USER_LABEL",
      });

    expect(res.status).toBe(201);
    expect(res.body.verified).toBe(false);
    expect(res.body.source).toBe("USER_LABEL");
  });

  it("returns 409 with the existing product on barcode conflict", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    vi.spyOn(p.product, "findUnique").mockResolvedValue(DB_PRODUCT as never);

    const res = await request(createApp())
      .post("/api/v1/products")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send({
        barcode: "8410100012345",
        name: "Otro nombre",
        calories_kcal_100g: 61,
        protein_g_100g: 3.5,
        carbs_g_100g: 4.7,
        fat_g_100g: 3.3,
        source: "MANUAL",
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PRODUCT_ALREADY_EXISTS");
    expect(res.body.product.barcode).toBe("8410100012345");
  });

  it("rejects incoherent macros with 422 MACROS_INCOHERENT (BR-026-01)", async () => {
    const { createApp } = await import("../../src/app");

    const res = await request(createApp())
      .post("/api/v1/products")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send({
        barcode: "8410100012345",
        name: "Producto imposible",
        calories_kcal_100g: 900,
        protein_g_100g: 1,
        carbs_g_100g: 1,
        fat_g_100g: 1,
        source: "MANUAL",
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("MACROS_INCOHERENT");
  });
});

describe("POST /api/v1/products/label-extraction", () => {
  it("returns extracted macros (200) when a label is readable", async () => {
    vi.doMock("../../src/integrations/geminiLabelClient.js", () => ({
      extractNutritionLabel: vi.fn().mockResolvedValue({
        isLabel: true,
        caloriesKcal100g: 480,
        proteinG100g: 7.5,
        carbsG100g: 60,
        fatG100g: 22,
        servingSizeG: 30,
        confidence: 0.9,
      }),
    }));
    const { createApp } = await import("../../src/app");

    const res = await request(createApp())
      .post("/api/v1/products/label-extraction")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send({
        image_base64: Buffer.from("fake-image").toString("base64"),
        mime_type: "image/jpeg",
      });

    expect(res.status).toBe(200);
    expect(res.body.calories_kcal_100g).toBe(480);
    expect(res.body.serving_size_g).toBe(30);
    expect(res.body.confidence).toBe(0.9);
  });

  it("returns 422 NOT_NUTRITION_LABEL when the photo has no legible table", async () => {
    vi.doMock("../../src/integrations/geminiLabelClient.js", () => ({
      extractNutritionLabel: vi.fn().mockResolvedValue({
        isLabel: false,
        caloriesKcal100g: 0,
        proteinG100g: 0,
        carbsG100g: 0,
        fatG100g: 0,
        confidence: 0.2,
      }),
    }));
    const { createApp } = await import("../../src/app");

    const res = await request(createApp())
      .post("/api/v1/products/label-extraction")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send({
        image_base64: Buffer.from("fake-image").toString("base64"),
        mime_type: "image/jpeg",
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("NOT_NUTRITION_LABEL");
  });

  it("maps exhausted provider failures to 503 IA_UNAVAILABLE", async () => {
    vi.doMock("../../src/integrations/geminiLabelClient.js", async () => {
      const { TransientProviderError } = await import(
        "../../src/integrations/providerErrors.js"
      );
      return {
        extractNutritionLabel: vi
          .fn()
          .mockRejectedValue(
            new TransientProviderError("gemini", "exhausted retries"),
          ),
      };
    });
    const { createApp } = await import("../../src/app");

    const res = await request(createApp())
      .post("/api/v1/products/label-extraction")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send({
        image_base64: Buffer.from("fake-image").toString("base64"),
        mime_type: "image/jpeg",
      });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("IA_UNAVAILABLE");
  });
});
