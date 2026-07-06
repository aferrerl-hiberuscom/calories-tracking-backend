/**
 * TASK-013-11: Unit tests for MealsService.saveMeal
 *
 * Mocks the shared prisma client singleton exported from src/lib/prisma.ts.
 * Uses vi.hoisted so mock functions are available before vi.mock is evaluated.
 *
 * Tests:
 * - Successful transaction resolves with { mealId: '<uuid>' }
 * - Prisma throws error → ApiError(500) is thrown
 * - Transaction creates Meal + Ingredients + NutritionalData + Image (all 4 calls)
 * - ApiError is re-thrown directly (no double-wrapping)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoist mock functions so they exist before vi.mock is evaluated ────────────

const {
  mockMealCreate,
  mockIngredientCreateMany,
  mockNutritionalDataCreate,
  mockImageCreate,
  mockTransaction,
} = vi.hoisted(() => {
  return {
    mockMealCreate: vi.fn(),
    mockIngredientCreateMany: vi.fn(),
    mockNutritionalDataCreate: vi.fn(),
    mockImageCreate: vi.fn(),
    mockTransaction: vi.fn(),
  };
});

// ─── Mock the prisma singleton ────────────────────────────────────────────────

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    $transaction: mockTransaction,
  },
}));

// Import after mock is set up
import { saveMeal } from "../meals.service";
import { ApiError } from "../../../middleware/api-error";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const USER_ID = "user-test-001";
const MEAL_ID = "meal-uuid-abc-123";

const validPayload = {
  image_url: "uploads/test-meal.jpg",
  // Evolution ui_redesign_brote (013 v2.0.0): dish name is required.
  name: "Arroz blanco con verduras",
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
      source: "VISIBLE",
      calories_kcal: 195,
      protein_g: 4.1,
      carbs_g: 43,
      fat_g: 0.4,
      cooking_method: "hervido",
      confidence: 0.9,
    },
  ],
};

// ─── Helper: configure $transaction to call the callback with mock tx ─────────

function setupSuccessfulTransaction(mealId = MEAL_ID) {
  mockTransaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<{ id: string }>) => {
      return fn({
        meal: { create: mockMealCreate.mockResolvedValue({ id: mealId }) },
        ingredient: { createMany: mockIngredientCreateMany.mockResolvedValue({ count: 1 }) },
        nutritionalData: { create: mockNutritionalDataCreate.mockResolvedValue({}) },
        image: { create: mockImageCreate.mockResolvedValue({}) },
      });
    },
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("saveMeal — success path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves with { mealId } matching the Meal record id on success", async () => {
    setupSuccessfulTransaction(MEAL_ID);

    const result = await saveMeal(USER_ID, validPayload);

    // 013 v2.0.0 (A-013-03): the service returns the A7 meal-card data too.
    expect(result).toEqual({
      mealId: MEAL_ID,
      name: validPayload.name,
      mealType: "LUNCH",
      mealDate: validPayload.meal_date,
      caloriesKcal: validPayload.calories_kcal,
    });
  });

  it("calls prisma.$transaction once", async () => {
    setupSuccessfulTransaction();

    await saveMeal(USER_ID, validPayload);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("creates a Meal record inside the transaction with status=confirmed", async () => {
    setupSuccessfulTransaction();

    await saveMeal(USER_ID, validPayload);

    expect(mockMealCreate).toHaveBeenCalledTimes(1);
    expect(mockMealCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: USER_ID,
          status: "confirmed",
        }),
      }),
    );
  });

  it("creates Ingredient rows inside the transaction with correct data", async () => {
    setupSuccessfulTransaction();

    await saveMeal(USER_ID, validPayload);

    expect(mockIngredientCreateMany).toHaveBeenCalledTimes(1);
    expect(mockIngredientCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            name: "Arroz blanco",
            quantityG: 150,
          }),
        ]),
      }),
    );
  });

  it("creates a NutritionalData record inside the transaction", async () => {
    setupSuccessfulTransaction();

    await saveMeal(USER_ID, validPayload);

    expect(mockNutritionalDataCreate).toHaveBeenCalledTimes(1);
    expect(mockNutritionalDataCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          caloriesKcal: validPayload.calories_kcal,
          proteinG: validPayload.protein_g,
        }),
      }),
    );
  });

  it("creates an Image record using image_url as storageKey", async () => {
    setupSuccessfulTransaction();

    await saveMeal(USER_ID, validPayload);

    expect(mockImageCreate).toHaveBeenCalledTimes(1);
    expect(mockImageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storageKey: validPayload.image_url,
        }),
      }),
    );
  });

  it("makes all 4 prisma calls (Meal + Ingredient + NutritionalData + Image) in one transaction", async () => {
    setupSuccessfulTransaction();

    await saveMeal(USER_ID, validPayload);

    expect(mockMealCreate).toHaveBeenCalledTimes(1);
    expect(mockIngredientCreateMany).toHaveBeenCalledTimes(1);
    expect(mockNutritionalDataCreate).toHaveBeenCalledTimes(1);
    expect(mockImageCreate).toHaveBeenCalledTimes(1);
  });
});

describe("saveMeal — error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws ApiError(500) when prisma.$transaction rejects with a generic DB error", async () => {
    mockTransaction.mockRejectedValue(new Error("DB connection failed"));

    await expect(saveMeal(USER_ID, validPayload)).rejects.toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
    });
  });

  it("throws ApiError(500) when prisma rejects with a Prisma-style error (P2002)", async () => {
    const prismaError = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      clientVersion: "5.0.0",
      meta: { target: ["id"] },
    });
    mockTransaction.mockRejectedValue(prismaError);

    await expect(saveMeal(USER_ID, validPayload)).rejects.toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
    });
  });

  it("re-throws ApiError directly without wrapping it in another ApiError", async () => {
    const originalApiError = new ApiError(503, "SERVICE_UNAVAILABLE", "DB is down");
    mockTransaction.mockRejectedValue(originalApiError);

    await expect(saveMeal(USER_ID, validPayload)).rejects.toMatchObject({
      status: 503,
      code: "SERVICE_UNAVAILABLE",
    });
  });

  it("thrown error is an instance of ApiError when transaction fails generically", async () => {
    mockTransaction.mockRejectedValue(new Error("Network timeout"));

    let caught: unknown;
    try {
      await saveMeal(USER_ID, validPayload);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(500);
  });
});
