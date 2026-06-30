// Nutritional validation service — feature 008
// Validates range, consistency, and suspicious values for calorie calculation results.
// Contract: contract_spec.md §Range Validation, §Duplicate Consolidation

import type {
  CalculatedIngredient,
  CalorieCalculationWarning,
} from "../types/calorieCalculation.types";

const MAX_MEAL_CALORIES_KCAL = 5000;
const MAX_MEAL_PROTEIN_G = 500;
const CONSISTENCY_TOLERANCE = 0.1; // ±10%
const DISCREPANCY_THRESHOLD = 0.2; // 20%
const LOW_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Validates that all nutritional values are non-negative.
 * Contract invariant 3: values MUST never be negative.
 */
export function validateNonNegative(ingredients: CalculatedIngredient[]): void {
  for (const ing of ingredients) {
    if (
      ing.calories_kcal < 0 ||
      ing.protein_g < 0 ||
      ing.carbs_g < 0 ||
      ing.fat_g < 0
    ) {
      throw new Error(
        `Negative nutritional value detected for ingredient "${ing.name}"`,
      );
    }
  }
}

/**
 * Flags meals with suspicious total nutritional values.
 * BR-014: calories > 5000 kcal | BR-011: protein > 500 g
 */
export function flagSuspiciousValues(
  totalCalories: number,
  totalProtein: number,
  warnings: CalorieCalculationWarning[],
): boolean {
  if (
    totalCalories > MAX_MEAL_CALORIES_KCAL ||
    totalProtein > MAX_MEAL_PROTEIN_G
  ) {
    warnings.push({
      type: "nutrition_suspicious",
      message: `Valores nutricionales sospechosos: ${totalCalories.toFixed(1)} kcal / ${totalProtein.toFixed(1)} g proteína. Por favor revisa los ingredientes.`,
    });
    return true;
  }
  return false;
}

/**
 * Checks macronutrient consistency: calories ≈ 4*protein + 4*carbs + 9*fat ± 10%
 * Contract invariant 4: consistency relationship MUST hold.
 */
export function checkConsistency(
  ingredient: CalculatedIngredient,
  warnings: CalorieCalculationWarning[],
): boolean {
  const expected =
    4 * ingredient.protein_g + 4 * ingredient.carbs_g + 9 * ingredient.fat_g;

  if (expected === 0) return true; // Cannot check zero-macro ingredient

  const diff = Math.abs(ingredient.calories_kcal - expected) / expected;

  if (diff > CONSISTENCY_TOLERANCE) {
    warnings.push({
      type: "consistency_mismatch",
      ingredient_name: ingredient.name,
      message: `Inconsistencia en macros de "${ingredient.name}": ${ingredient.calories_kcal.toFixed(1)} kcal declaradas vs ${expected.toFixed(1)} kcal esperadas (margen ±10%)`,
    });
    return false;
  }

  return true;
}

/**
 * Flags ingredients with low confidence.
 * BR-012: confidence < 0.5 → low confidence visual indicator.
 */
export function buildLowConfidenceWarnings(
  ingredients: CalculatedIngredient[],
  warnings: CalorieCalculationWarning[],
): void {
  for (const ing of ingredients) {
    if (ing.confidence < LOW_CONFIDENCE_THRESHOLD) {
      warnings.push({
        type: "low_confidence",
        ingredient_name: ing.name,
        message: `Baja confianza en "${ing.name}" (${Math.round(ing.confidence * 100)}%). Verifica manualmente.`,
      });
    }
  }
}

/**
 * Consolidates duplicate ingredient entries by summing quantities.
 * Contract §Duplicate Consolidation: sum quantities, keep highest confidence source.
 */
export function consolidateDuplicates(
  ingredients: CalculatedIngredient[],
): CalculatedIngredient[] {
  const map = new Map<string, CalculatedIngredient>();

  for (const ing of ingredients) {
    const key = ing.name.trim().toLowerCase();
    const existing = map.get(key);

    if (existing) {
      // Sum quantities; recalculate macros proportionally
      const totalQty = existing.quantity_g + ing.quantity_g;
      const maxConf = Math.max(existing.confidence, ing.confidence);
      const dominantSource =
        existing.confidence >= ing.confidence ? existing.source : ing.source;

      map.set(key, {
        ...existing,
        quantity_g: totalQty,
        confidence: maxConf,
        source: dominantSource,
        calories_kcal: existing.calories_kcal + ing.calories_kcal,
        protein_g: existing.protein_g + ing.protein_g,
        carbs_g: existing.carbs_g + ing.carbs_g,
        fat_g: existing.fat_g + ing.fat_g,
      });
    } else {
      map.set(key, { ...ing });
    }
  }

  return Array.from(map.values());
}

/**
 * Detects significant discrepancies between AI-calculated values and DB reference values.
 * Contract §Discrepancy Detection: >20% diff → flag discrepancy_detected.
 */
export function detectDiscrepancy(
  aiCalories: number,
  dbCalories: number,
): boolean {
  if (dbCalories === 0) return false;
  const diff = Math.abs(aiCalories - dbCalories) / dbCalories;
  return diff > DISCREPANCY_THRESHOLD;
}
