// Ingredient repository — feature 007
// Prisma DAL for meal_ingredients table.

import { IngredientSource } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import type { IngredientEstimate } from "../types/estimateQuantities.types.js";

export async function createManyIngredients(
  mealId: string,
  ingredients: IngredientEstimate[],
): Promise<void> {
  await prisma.ingredient.createMany({
    data: ingredients.map((ing) => ({
      mealId,
      name: ing.name,
      quantityG: ing.quantity_g,
      source: ing.source as IngredientSource,
      confidence: ing.confidence,
      quantitySuspicious: ing.quantity_suspicious,
      cookingMethod: null,
      caloriesKcal: ing.macros.calories_kcal,
      proteinG: ing.macros.protein_g,
      carbsG: ing.macros.carbs_g,
      fatG: ing.macros.fat_g,
    })),
  });
}

export async function updateIngredientQuantity(
  ingredientId: string,
  mealId: string,
  quantityG: number,
  newMacros: {
    calories_kcal: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
  },
) {
  return prisma.ingredient.update({
    where: { id: ingredientId, mealId },
    data: {
      quantityG,
      source: IngredientSource.MANUAL,
      confidence: 1.0,
      quantitySuspicious: false,
      caloriesKcal: newMacros.calories_kcal,
      proteinG: newMacros.protein_g,
      carbsG: newMacros.carbs_g,
      fatG: newMacros.fat_g,
    },
  });
}

export async function findByMealId(mealId: string) {
  return prisma.ingredient.findMany({
    where: { mealId },
    orderBy: { name: "asc" },
  });
}

export async function deleteManyByMealId(mealId: string): Promise<void> {
  await prisma.ingredient.deleteMany({ where: { mealId } });
}
