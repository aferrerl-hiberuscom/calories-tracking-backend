// Estimate quantities service — feature 007
// Core business logic: orchestrates OpenAI Vision call → validation → macro calculation → persistence.

import { ApiError } from "../middleware/api-error";
import {
  analyzePortions,
  VisionApiError,
} from "../integrations/openAIVisionClient.js";
import {
  lookupNutritionalData,
  calculateMacros,
} from "./nutritionalData.service.js";
import * as ingredientRepo from "../repositories/mealIngredient.repository.js";
import { prisma } from "../lib/prisma.js";
import type {
  IngredientEstimate,
  IngredientInput,
  IngredientSource,
  EstimateQuantitiesResponse,
  QuantityWarning,
  UpdateQuantityResponse,
} from "../types/estimateQuantities.types";

const MIN_QUANTITY_G = 1;
const MAX_QUANTITY_G = 5000;
const LOW_CONFIDENCE_THRESHOLD = 0.5;
const TOTAL_WEIGHT_WARNING_G = 5000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateQuantityRanges(
  ingredients: IngredientEstimate[],
  warnings: QuantityWarning[],
): IngredientEstimate[] {
  return ingredients.map((ing) => {
    if (ing.quantity_g < MIN_QUANTITY_G || ing.quantity_g > MAX_QUANTITY_G) {
      warnings.push({
        type: "out_of_range",
        ingredient_name: ing.name,
        message: `Cantidad de ${ing.name} (${ing.quantity_g}g) fuera del rango esperado (1–5000g)`,
      });
      return { ...ing, quantity_suspicious: true };
    }
    return ing;
  });
}

function consolidateDuplicates(
  ingredients: IngredientEstimate[],
): IngredientEstimate[] {
  const map = new Map<string, IngredientEstimate>();

  for (const ing of ingredients) {
    const key = ing.name.trim().toLowerCase();
    const existing = map.get(key);
    if (existing) {
      map.set(key, {
        ...existing,
        quantity_g: existing.quantity_g + ing.quantity_g,
        confidence: Math.max(existing.confidence, ing.confidence),
        source: "CONSOLIDATED" as IngredientSource,
      });
    } else {
      map.set(key, { ...ing });
    }
  }

  return Array.from(map.values());
}

function buildLowConfidenceWarnings(
  ingredients: IngredientEstimate[],
): QuantityWarning[] {
  return ingredients
    .filter((ing) => ing.confidence < LOW_CONFIDENCE_THRESHOLD)
    .map((ing) => ({
      type: "low_confidence" as const,
      ingredient_name: ing.name,
      message: `Baja confianza en la estimación de ${ing.name} (${Math.round(ing.confidence * 100)}%)`,
    }));
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function estimateQuantities(
  mealId: string,
  imageUrl: string,
  ingredientInputs: IngredientInput[],
): Promise<EstimateQuantitiesResponse> {
  if (!ingredientInputs.length) {
    throw new ApiError(
      400,
      "INVALID_PAYLOAD",
      "ingredients array cannot be empty",
    );
  }
  if (!imageUrl) {
    throw new ApiError(400, "INVALID_PAYLOAD", "image_url is required");
  }

  // Step 1: Call OpenAI Vision API
  let portions: Awaited<ReturnType<typeof analyzePortions>>;
  try {
    portions = await analyzePortions(imageUrl, ingredientInputs);
  } catch (err) {
    if (err instanceof VisionApiError) {
      throw new ApiError(503, "VISION_API_UNAVAILABLE", err.message);
    }
    throw err;
  }

  const warnings: QuantityWarning[] = [];

  // Step 2: Map to IngredientEstimate (partial — no macros yet)
  let ingredients: IngredientEstimate[] = portions.map((p) => {
    if (p.source === "missing") {
      warnings.push({
        type: "missing_ingredient",
        ingredient_name: p.name,
        message: `No se pudo estimar la cantidad de ${p.name}`,
      });
    }
    return {
      name: p.name,
      quantity_g: p.source === "missing" ? 0 : p.quantity_g,
      confidence: p.confidence,
      source: (p.source === "missing"
        ? "MISSING"
        : "VISIBLE") as IngredientSource,
      quantity_suspicious: false,
      macros: { calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
    };
  });

  // Add any inputs not returned by AI
  const returnedNames = new Set(
    portions.map((p) => p.name.trim().toLowerCase()),
  );
  for (const input of ingredientInputs) {
    if (!returnedNames.has(input.name.trim().toLowerCase())) {
      warnings.push({
        type: "missing_ingredient",
        ingredient_name: input.name,
        message: `No se pudo estimar la cantidad de ${input.name}`,
      });
      ingredients.push({
        name: input.name,
        quantity_g: 0,
        confidence: 0,
        source: "MISSING" as IngredientSource,
        quantity_suspicious: false,
        macros: { calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
      });
    }
  }

  // Step 3: Validate ranges
  ingredients = validateQuantityRanges(ingredients, warnings);

  // Step 4: Consolidate duplicates
  ingredients = consolidateDuplicates(ingredients);

  // Step 5: Lookup nutritional data and calculate macros
  ingredients = await Promise.all(
    ingredients.map(async (ing) => {
      if (ing.quantity_g === 0) return ing;

      const nutrition = await lookupNutritionalData(ing.name);
      const macros = calculateMacros(ing.quantity_g, nutrition);
      const isGeneric =
        ing.source !== "CONSOLIDATED" && ing.source !== "MANUAL";

      // Check if fallback was used (approximation)
      const refRows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM nutritional_reference
        WHERE LOWER(name) = LOWER(${ing.name})
        LIMIT 1
      `;
      const refEntry = refRows[0] ?? null;

      const usedGeneric = !refEntry;
      if (usedGeneric && isGeneric) {
        warnings.push({
          type: "generic_estimate",
          ingredient_name: ing.name,
          message: `Valores nutricionales aproximados para ${ing.name} (categoría genérica)`,
        });
      }

      return {
        ...ing,
        source:
          usedGeneric && isGeneric
            ? ("ESTIMATED_GENERIC" as IngredientSource)
            : ing.source,
        macros,
      };
    }),
  );

  // Step 6: Low confidence warnings
  warnings.push(...buildLowConfidenceWarnings(ingredients));

  // Step 7: Total weight
  const total_weight_g = ingredients.reduce((sum, i) => sum + i.quantity_g, 0);
  if (total_weight_g > TOTAL_WEIGHT_WARNING_G) {
    warnings.push({
      type: "out_of_range",
      ingredient_name: "total",
      message: `Peso total del plato (${total_weight_g}g) es inusualmente alto`,
    });
  }

  // Step 8: Persist
  await ingredientRepo.deleteManyByMealId(mealId);
  await ingredientRepo.createManyIngredients(mealId, ingredients);

  return {
    meal_id: mealId,
    estimated_at: new Date().toISOString(),
    ingredients,
    total_weight_g,
    warnings,
  };
}

export async function updateIngredientQuantity(
  ingredientId: string,
  mealId: string,
  quantityG: number,
): Promise<UpdateQuantityResponse> {
  if (quantityG < MIN_QUANTITY_G || quantityG > MAX_QUANTITY_G) {
    throw new ApiError(
      422,
      "QUANTITY_OUT_OF_RANGE",
      `quantity_g must be between ${MIN_QUANTITY_G} and ${MAX_QUANTITY_G}`,
    );
  }

  // Lookup nutritional data to recalculate macros
  const current = await prisma.ingredient.findUnique({
    where: { id: ingredientId },
  });
  if (!current || current.mealId !== mealId) {
    throw new ApiError(
      404,
      "INGREDIENT_NOT_FOUND",
      "Ingredient not found in this meal",
    );
  }

  const nutrition = await lookupNutritionalData(current.name);
  const newMacros = calculateMacros(quantityG, nutrition);

  const updated = await ingredientRepo.updateIngredientQuantity(
    ingredientId,
    mealId,
    quantityG,
    newMacros,
  );

  return {
    ingredient_id: updated.id,
    meal_id: updated.mealId,
    name: updated.name,
    quantity_g: updated.quantityG,
    source: "MANUAL",
    confidence: 1.0,
    macros: {
      calories_kcal: updated.caloriesKcal ?? 0,
      protein_g: updated.proteinG ?? 0,
      carbs_g: updated.carbsG ?? 0,
      fat_g: updated.fatG ?? 0,
    },
    updated_at: new Date().toISOString(),
  };
}
