/**
 * Feature 013 — Confirmación y guardado de comida
 * Service: saveMeal — atomic persistence of a confirmed meal.
 */

import type { IngredientSource, MealType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { ApiError } from "../../middleware/api-error";
import { inferMealTypeFromIso } from "../../lib/meal-type";
import type { MealPayload } from "./validateMealPayload";

export interface SaveMealResult {
  mealId: string;
  name: string;
  mealType: MealType;
  mealDate: string;
  caloriesKcal: number;
}

/**
 * Persists a validated meal payload atomically using a Prisma transaction.
 *
 * If idempotencyKey is provided and a Meal already exists for (userId, idempotencyKey),
 * the existing mealId is returned without creating a duplicate (FR-013-10).
 *
 * On any failure the transaction rolls back completely and an ApiError(500) is thrown.
 */
export async function saveMeal(
  userId: string,
  payload: MealPayload,
  idempotencyKey?: string
): Promise<SaveMealResult> {
  // Contract 013 v2.0.0 (A-013-02): meal type inferred from the local hour
  // written in meal_date, persisted at save time.
  const mealType = inferMealTypeFromIso(payload.meal_date);

  try {
    // Idempotency check — return existing meal if key already used by this user
    if (idempotencyKey) {
      const existing = await prisma.meal.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
        select: {
          id: true,
          name: true,
          mealType: true,
          mealDate: true,
          nutrition: { select: { caloriesKcal: true } },
        },
      });
      if (existing) {
        return {
          mealId: existing.id,
          name: existing.name,
          mealType: existing.mealType,
          mealDate: existing.mealDate.toISOString(),
          caloriesKcal: existing.nutrition?.caloriesKcal ?? 0,
        };
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1. Insert Meal
      const meal = await tx.meal.create({
        data: {
          userId,
          name: payload.name,
          mealType,
          mealDate: new Date(payload.meal_date),
          status: "confirmed",
          idempotencyKey: idempotencyKey ?? null,
        },
      });

      // 2. Insert Ingredients
      await tx.ingredient.createMany({
        data: payload.ingredients.map((ing) => ({
          mealId: meal.id,
          name: ing.name,
          quantityG: ing.quantity_g,
          source: ing.source.toUpperCase() as IngredientSource,
          confidence: ing.confidence ?? null,
          cookingMethod: ing.cooking_method ?? null,
          caloriesKcal: ing.calories_kcal,
          proteinG: ing.protein_g,
          carbsG: ing.carbs_g,
          fatG: ing.fat_g,
        })),
      });

      // 3. Insert NutritionalData (model exists in schema)
      await tx.nutritionalData.create({
        data: {
          mealId: meal.id,
          caloriesKcal: payload.calories_kcal,
          proteinG: payload.protein_g,
          carbsG: payload.carbs_g,
          fatG: payload.fat_g,
          totalWeightG: payload.total_weight_g,
        },
      });

      // 4. Insert Image record using image_url as storageKey.
      // Contract 013 v2.1.0 (A-013-05): manual creation has no photo — skip.
      if (payload.image_url !== undefined) {
        await tx.image.create({
          data: {
            mealId: meal.id,
            storageKey: payload.image_url,
            mimeType: "image/jpeg", // default; contract only provides a URL reference
            sizeBytes: null, // populated when real image metadata is available
          },
        });
      }

      return meal;
    });

    return {
      mealId: result.id,
      name: payload.name,
      mealType,
      mealDate: new Date(payload.meal_date).toISOString(),
      caloriesKcal: payload.calories_kcal,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    // Wrap any Prisma or unexpected error as a generic internal error
    throw new ApiError(500, "INTERNAL_ERROR", "Failed to persist meal");
  }
}
