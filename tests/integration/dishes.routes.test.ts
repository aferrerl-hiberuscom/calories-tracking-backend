// Feature 027 — dishes routes integration tests (contract §3).
// Feature 028 — personal catalog: GET / and DELETE /:id (contract 028 §3).
// Patterns mirror products.routes.test.ts: supertest, prisma spies, and the
// Gemini dish-name client mocked at module level.

import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateMealPayload } from "../../src/services/meals/validateMealPayload";

const TEST_USER_ID = "user-dishes-test";

function buildToken(sub: string): string {
  return jwt.sign({ sub }, process.env.JWT_SECRET ?? "change-me");
}

const DISH_PAYLOAD = {
  name: "Ensalada césar",
  ingredients: [
    {
      name: "Lechuga",
      product_barcode: "8410100012345",
      quantity_g: 80,
      calories_kcal: 12,
      protein_g: 1.1,
      carbs_g: 1.8,
      fat_g: 0.2,
    },
    {
      name: "Pechuga de pollo",
      quantity_g: 120,
      calories_kcal: 198,
      protein_g: 37.2,
      carbs_g: 0,
      fat_g: 4.3,
    },
  ],
};

const DB_DISH = {
  id: "dish-1",
  userId: TEST_USER_ID,
  name: "Ensalada césar",
  sourceMealId: null as string | null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ingredients: [
    {
      id: "di-1",
      dishId: "dish-1",
      name: "Lechuga",
      productBarcode: "8410100012345",
      quantityG: 80,
      caloriesKcal: 12,
      proteinG: 1.1,
      carbsG: 1.8,
      fatG: 0.2,
    },
  ],
};

// Feature favoritos_mis_platos: a meal to favorite (with ingredients to snapshot).
const DB_MEAL = {
  id: "meal-1",
  userId: TEST_USER_ID,
  name: "Albóndigas con salsa",
  mealType: "DINNER",
  mealDate: new Date(),
  status: "confirmed",
  createdAt: new Date(),
  updatedAt: new Date(),
  ingredients: [
    {
      id: "mi-1",
      mealId: "meal-1",
      name: "Albóndigas",
      quantityG: 150,
      source: "INFERRED",
      caloriesKcal: 300,
      proteinG: 20,
      carbsG: 10,
      fatG: 18,
    },
  ],
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

describe("POST /api/v1/dishes/suggest-name", () => {
  it("returns the inferred name (200) when the provider responds", async () => {
    vi.doMock("../../src/integrations/geminiDishNameClient.js", () => ({
      suggestDishNameWithGemini: vi.fn().mockResolvedValue({
        dishName: "Ensalada césar",
        confidence: 0.9,
      }),
    }));
    const { createApp } = await import("../../src/app");

    const res = await request(createApp())
      .post("/api/v1/dishes/suggest-name")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send({
        ingredient_names: ["Lechuga", "Croutons", "Parmesano", "Pollo"],
      });

    expect(res.status).toBe(200);
    expect(res.body.dish_name).toBe("Ensalada césar");
    expect(res.body.confidence).toBe(0.9);
  });

  it("degrades to 200 with dish_name null when the provider is down (BR-027-03)", async () => {
    vi.doMock("../../src/integrations/geminiDishNameClient.js", async () => {
      const { TransientProviderError } = await import(
        "../../src/integrations/providerErrors.js"
      );
      return {
        suggestDishNameWithGemini: vi
          .fn()
          .mockRejectedValue(
            new TransientProviderError("gemini", "exhausted"),
          ),
      };
    });
    const { createApp } = await import("../../src/app");

    const res = await request(createApp())
      .post("/api/v1/dishes/suggest-name")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send({ ingredient_names: ["Lechuga", "Pollo"] });

    expect(res.status).toBe(200);
    expect(res.body.dish_name).toBeNull();
    expect(res.body.confidence).toBe(0);
  });

  it("rejects payloads with fewer than 2 names (400)", async () => {
    const { createApp } = await import("../../src/app");

    const res = await request(createApp())
      .post("/api/v1/dishes/suggest-name")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send({ ingredient_names: ["Solo uno"] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/v1/dishes", () => {
  it("creates a per-user dish atomically (201)", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    const createSpy = vi
      .spyOn(p.dish, "create")
      .mockResolvedValue(DB_DISH as never);

    const res = await request(createApp())
      .post("/api/v1/dishes")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send(DISH_PAYLOAD);

    expect(res.status).toBe(201);
    expect(res.body.dish_id).toBe("dish-1");
    expect(res.body.name).toBe("Ensalada césar");
    // Ownership: dish is created for the authenticated user (BR-027-02)
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: TEST_USER_ID }),
      }),
    );
  });

  it("rejects invalid payloads (400) — empty ingredients", async () => {
    const { createApp } = await import("../../src/app");

    const res = await request(createApp())
      .post("/api/v1/dishes")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`)
      .send({ name: "Plato vacío", ingredients: [] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("requires authentication (401)", async () => {
    const { createApp } = await import("../../src/app");
    const res = await request(createApp())
      .post("/api/v1/dishes")
      .send(DISH_PAYLOAD);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/dishes", () => {
  it("lists only the authenticated user's dishes, newest first (BR-028-01)", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    const findSpy = vi
      .spyOn(p.dish, "findMany")
      .mockResolvedValue([DB_DISH] as never);

    const res = await request(createApp())
      .get("/api/v1/dishes")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.dishes).toHaveLength(1);
    expect(res.body.dishes[0].dish_id).toBe("dish-1");
    expect(res.body.dishes[0].ingredients[0]).toEqual({
      name: "Lechuga",
      product_barcode: "8410100012345",
      quantity_g: 80,
      calories_kcal: 12,
      protein_g: 1.1,
      carbs_g: 1.8,
      fat_g: 0.2,
    });
    // Ownership + ordering enforced in the query itself
    expect(findSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: TEST_USER_ID },
        orderBy: { createdAt: "desc" },
      }),
    );
  });

  it("returns 200 with an empty list when the catalog is empty (AC-028-02)", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    vi.spyOn(p.dish, "findMany").mockResolvedValue([] as never);

    const res = await request(createApp())
      .get("/api/v1/dishes")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.dishes).toEqual([]);
  });

  it("requires authentication (401)", async () => {
    const { createApp } = await import("../../src/app");
    const res = await request(createApp()).get("/api/v1/dishes");
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/v1/dishes/:id", () => {
  it("deletes an owned dish (204) using the compound filter (BR-028-02)", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    const deleteSpy = vi
      .spyOn(p.dish, "deleteMany")
      .mockResolvedValue({ count: 1 } as never);

    const res = await request(createApp())
      .delete("/api/v1/dishes/dish-1")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(res.status).toBe(204);
    expect(deleteSpy).toHaveBeenCalledWith({
      where: { id: "dish-1", userId: TEST_USER_ID },
    });
  });

  it("answers 404 DISH_NOT_FOUND for a foreign or missing dish (AC-028-04)", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    vi.spyOn(p.dish, "deleteMany").mockResolvedValue({ count: 0 } as never);

    const res = await request(createApp())
      .delete("/api/v1/dishes/dish-of-another-user")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("DISH_NOT_FOUND");
  });

  it("requires authentication (401)", async () => {
    const { createApp } = await import("../../src/app");
    const res = await request(createApp()).delete("/api/v1/dishes/dish-1");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/meals/:id/favorite (028 v2.0.0)", () => {
  it("creates a favorite Dish snapshot linked to the meal (201, BR-028-10)", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    vi.spyOn(p.meal, "findFirst").mockResolvedValue(DB_MEAL as never);
    vi.spyOn(p.dish, "findUnique").mockResolvedValue(null as never);
    const createSpy = vi
      .spyOn(p.dish, "create")
      .mockResolvedValue({ ...DB_DISH, sourceMealId: "meal-1" } as never);

    const res = await request(createApp())
      .post("/api/v1/meals/meal-1/favorite")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(res.status).toBe(201);
    expect(res.body.dish_id).toBe("dish-1");
    // Snapshot links to the meal and carries the meal name.
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: TEST_USER_ID,
          sourceMealId: "meal-1",
          name: "Albóndigas con salsa",
        }),
      }),
    );
  });

  it("is idempotent: returns 200 with the existing favorite, no duplicate (BR-028-11)", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    vi.spyOn(p.meal, "findFirst").mockResolvedValue(DB_MEAL as never);
    vi.spyOn(p.dish, "findUnique").mockResolvedValue({
      ...DB_DISH,
      sourceMealId: "meal-1",
    } as never);
    const createSpy = vi.spyOn(p.dish, "create");

    const res = await request(createApp())
      .post("/api/v1/meals/meal-1/favorite")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.dish_id).toBe("dish-1");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("answers 404 MEAL_NOT_FOUND for a foreign or missing meal (AC-028-21)", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    vi.spyOn(p.meal, "findFirst").mockResolvedValue(null as never);

    const res = await request(createApp())
      .post("/api/v1/meals/meal-of-another-user/favorite")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("MEAL_NOT_FOUND");
  });

  it("requires authentication (401)", async () => {
    const { createApp } = await import("../../src/app");
    const res = await request(createApp()).post("/api/v1/meals/meal-1/favorite");
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/v1/meals/:id/favorite (028 v2.0.0)", () => {
  it("deletes the linked Dish and answers 204 (AC-028-20)", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    vi.spyOn(p.meal, "findFirst").mockResolvedValue(DB_MEAL as never);
    const deleteSpy = vi
      .spyOn(p.dish, "deleteMany")
      .mockResolvedValue({ count: 1 } as never);

    const res = await request(createApp())
      .delete("/api/v1/meals/meal-1/favorite")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(res.status).toBe(204);
    expect(deleteSpy).toHaveBeenCalledWith({
      where: { sourceMealId: "meal-1", userId: TEST_USER_ID },
    });
  });

  it("is idempotent: 204 even when there was no favorite (AC-028-20)", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    vi.spyOn(p.meal, "findFirst").mockResolvedValue(DB_MEAL as never);
    vi.spyOn(p.dish, "deleteMany").mockResolvedValue({ count: 0 } as never);

    const res = await request(createApp())
      .delete("/api/v1/meals/meal-1/favorite")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(res.status).toBe(204);
  });

  it("answers 404 MEAL_NOT_FOUND for a foreign or missing meal", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    vi.spyOn(p.meal, "findFirst").mockResolvedValue(null as never);

    const res = await request(createApp())
      .delete("/api/v1/meals/gone/favorite")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("MEAL_NOT_FOUND");
  });
});

describe("GET /api/v1/meals — is_favorite in DTOs (AC-028-22)", () => {
  it("marks is_favorite true when a favorite Dish is linked", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    vi.spyOn(p.meal, "findMany").mockResolvedValue([
      {
        id: "meal-1",
        name: "Albóndigas con salsa",
        mealType: "DINNER",
        mealDate: new Date(),
        status: "confirmed",
        createdAt: new Date(),
        updatedAt: new Date(),
        nutrition: {
          caloriesKcal: 300,
          proteinG: 20,
          carbsG: 10,
          fatG: 18,
          totalWeightG: 150,
        },
        image: null,
        favoriteDish: { id: "dish-1" },
      },
    ] as never);

    const res = await request(createApp())
      .get("/api/v1/meals")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.meals[0].is_favorite).toBe(true);
  });

  it("marks is_favorite false when no favorite Dish is linked", async () => {
    const { createApp } = await import("../../src/app");
    const { prisma: p } = await import("../../src/lib/prisma.js");
    vi.spyOn(p.meal, "findMany").mockResolvedValue([
      {
        id: "meal-2",
        name: "Bebida de avena",
        mealType: "SNACK",
        mealDate: new Date(),
        status: "confirmed",
        createdAt: new Date(),
        updatedAt: new Date(),
        nutrition: null,
        image: null,
        favoriteDish: null,
      },
    ] as never);

    const res = await request(createApp())
      .get("/api/v1/meals")
      .set("Authorization", `Bearer ${buildToken(TEST_USER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.meals[0].is_favorite).toBe(false);
  });
});

describe("013 v2.3.0 — meals accept MULTIPLE PRODUCT ingredients", () => {
  it("validates a meal payload with 3 PRODUCT ingredients", () => {
    const ing = (name: string, qty: number, kcal: number) => ({
      name,
      quantity_g: qty,
      source: "PRODUCT",
      calories_kcal: kcal,
      protein_g: 1,
      carbs_g: 1,
      fat_g: 1,
    });
    const result = validateMealPayload({
      name: "Ensalada césar",
      meal_date: new Date().toISOString(),
      total_weight_g: 300,
      calories_kcal: 360,
      protein_g: 3,
      carbs_g: 3,
      fat_g: 3,
      ingredients: [
        ing("Lechuga", 100, 120),
        ing("Pollo", 100, 120),
        ing("Salsa césar", 100, 120),
      ],
    });
    expect(result.valid).toBe(true);
  });
});
