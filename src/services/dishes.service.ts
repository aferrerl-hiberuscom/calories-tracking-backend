// Feature 027 — per-user reusable dishes (contract §2/§3).
// createDish: atomic insert of dish + ingredients, strictly owned by userId
// (D-MULTI-06). suggestName: best-effort wrapper around the Gemini text
// client — ANY provider failure resolves to null so the flow never blocks
// (BR-027-03); the route always answers 200 for valid payloads.

import { prisma } from "../lib/prisma";
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

  return {
    dish_id: created.id,
    name: created.name,
    created_at: created.createdAt.toISOString(),
    ingredients: created.ingredients.map((ing) => ({
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
