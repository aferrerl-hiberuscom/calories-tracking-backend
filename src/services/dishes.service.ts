// Feature 027 — per-user reusable dishes (contract §2/§3).
// createDish: atomic insert of dish + ingredients, strictly owned by userId
// (D-MULTI-06). suggestName: best-effort wrapper around the Gemini text
// client — ANY provider failure resolves to null so the flow never blocks
// (BR-027-03); the route always answers 200 for valid payloads.
// Feature 028 — listDishes/deleteDish: personal catalog read/delete, both
// filtered by userId (BR-028-01/02).

import { prisma } from "../lib/prisma";
import type { Dish, DishIngredient } from "@prisma/client";
import { suggestDishNameWithGemini } from "../integrations/geminiDishNameClient";

export type DishIngredientInput = {
  name: string;
  product_barcode?: string;
  quantity_g: number;
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

export type CreateDishInput = {
  name: string;
  ingredients: DishIngredientInput[];
};

export type DishDto = {
  dish_id: string;
  name: string;
  created_at: string;
  ingredients: DishIngredientInput[];
};

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ service: "dishes", ...fields }));
}

/** Single Prisma→DTO mapper so GET and POST answer the exact same shape. */
function toDishDto(dish: Dish & { ingredients: DishIngredient[] }): DishDto {
  return {
    dish_id: dish.id,
    name: dish.name,
    created_at: dish.createdAt.toISOString(),
    ingredients: dish.ingredients.map((ing) => ({
      name: ing.name,
      product_barcode: ing.productBarcode ?? undefined,
      quantity_g: ing.quantityG,
      calories_kcal: ing.caloriesKcal,
      protein_g: ing.proteinG,
      carbs_g: ing.carbsG,
      fat_g: ing.fatG,
    })),
  };
}

/** Atomic dish creation (BR-027-01): dish + ingredients in one transaction. */
export async function createDish(
  userId: string,
  input: CreateDishInput,
): Promise<DishDto> {
  const created = await prisma.dish.create({
    data: {
      userId,
      name: input.name.trim().slice(0, 120),
      ingredients: {
        create: input.ingredients.map((ing) => ({
          name: ing.name.trim().slice(0, 120),
          productBarcode: ing.product_barcode,
          quantityG: ing.quantity_g,
          caloriesKcal: ing.calories_kcal,
          proteinG: ing.protein_g,
          carbsG: ing.carbs_g,
          fatG: ing.fat_g,
        })),
      },
    },
    include: { ingredients: true },
  });

  log({
    level: "info",
    action: "dish_created",
    ingredient_count: created.ingredients.length,
  });

  return toDishDto(created);
}

/** Personal catalog, newest first (BR-028-01: always scoped to userId). */
export async function listDishes(userId: string): Promise<DishDto[]> {
  const dishes = await prisma.dish.findMany({
    where: { userId },
    include: { ingredients: true },
    orderBy: { createdAt: "desc" },
  });

  log({ level: "info", action: "dishes_listed", dish_count: dishes.length });

  return dishes.map(toDishDto);
}

/**
 * Deletes an owned dish (ingredients cascade). Returns false when the dish
 * does not exist OR belongs to another user — the compound filter decides in
 * one statement, with no prior lookup that could leak existence (BR-028-02).
 */
export async function deleteDish(
  userId: string,
  dishId: string,
): Promise<boolean> {
  const { count } = await prisma.dish.deleteMany({
    where: { id: dishId, userId },
  });

  if (count > 0) {
    log({ level: "info", action: "dish_deleted" });
  }
  return count > 0;
}

// ─── Feature favoritos_mis_platos ─────────────────────────────────────────────

/**
 * Marks a meal as favorite by materializing a Dish snapshot linked to it
 * (BR-028-10). Idempotent (BR-028-11): if the meal already has a favorite Dish
 * it is returned untouched (`created:false`). Returns null when the meal does
 * not exist or belongs to another user → the route answers 404.
 */
export async function favoriteMeal(
  userId: string,
  mealId: string,
): Promise<{ dish: DishDto; created: boolean } | null> {
  const meal = await prisma.meal.findFirst({
    where: { id: mealId, userId },
    include: { ingredients: true },
  });
  if (!meal) return null;

  // sourceMealId is @unique → at most one favorite Dish per meal.
  const existing = await prisma.dish.findUnique({
    where: { sourceMealId: mealId },
    include: { ingredients: true },
  });
  if (existing) {
    return { dish: toDishDto(existing), created: false };
  }

  const created = await prisma.dish.create({
    data: {
      userId,
      name: meal.name.trim().slice(0, 120),
      sourceMealId: mealId,
      // Snapshot from the meal's ingredients. Meal ingredients carry no
      // barcode → productBarcode stays null (source MANUAL on re-registration).
      ingredients: {
        create: meal.ingredients.map((ing) => ({
          name: ing.name.trim().slice(0, 120),
          quantityG: ing.quantityG,
          caloriesKcal: ing.caloriesKcal,
          proteinG: ing.proteinG,
          carbsG: ing.carbsG,
          fatG: ing.fatG,
        })),
      },
    },
    include: { ingredients: true },
  });

  log({
    level: "info",
    action: "dish_favorited",
    ingredient_count: created.ingredients.length,
  });

  return { dish: toDishDto(created), created: true };
}

/**
 * Unmarks a meal as favorite by deleting the linked Dish. Idempotent: returns
 * true even when there was no favorite (nothing to delete). Returns null when
 * the meal does not exist or is not the user's → the route answers 404.
 */
export async function unfavoriteMeal(
  userId: string,
  mealId: string,
): Promise<boolean | null> {
  const meal = await prisma.meal.findFirst({ where: { id: mealId, userId } });
  if (!meal) return null;

  const { count } = await prisma.dish.deleteMany({
    where: { sourceMealId: mealId, userId },
  });
  if (count > 0) {
    log({ level: "info", action: "dish_unfavorited" });
  }
  return true;
}

/**
 * Best-effort dish-name inference (BR-027-03): resolves to null on ANY
 * provider failure — callers use the default name and never surface errors.
 */
export async function suggestName(
  ingredientNames: string[],
): Promise<{ dish_name: string | null; confidence: number }> {
  const start = Date.now();
  try {
    const suggestion = await suggestDishNameWithGemini(ingredientNames);
    log({
      level: "info",
      action: "dish_name_suggested",
      dish_name_inferred: suggestion.dishName !== null,
      latency_ms: Date.now() - start,
    });
    return {
      dish_name: suggestion.dishName,
      confidence: suggestion.confidence,
    };
  } catch (err) {
    log({
      level: "warn",
      action: "dish_name_suggestion_failed",
      dish_name_inferred: false,
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
    return { dish_name: null, confidence: 0 };
  }
}
