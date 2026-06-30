// Calorie calculation service — feature 008
// Orchestrates nutritional calculation for ingredients with known quantities.
// Input: ingredient list with quantity_g (from feature 007)
// Output: per-ingredient nutritional values + meal totals
// Contract: contract_spec.md §Calorie Calculation Pipeline

import {
  lookupNutritionalData,
  calculateMacros,
} from "./nutritionalData.service";
import {
  validateNonNegative,
  flagSuspiciousValues,
  checkConsistency,
  buildLowConfidenceWarnings,
  consolidateDuplicates,
  detectDiscrepancy,
} from "./nutritionalValidation.service";
import type {
  IngredientWithQuantity,
  CalculatedIngredient,
  CalorieCalculationResult,
  CalorieCalculationTotals,
  CalorieCalculationWarning,
} from "../types/calorieCalculation.types";

// AI nutritional extraction — parses macros from analyze-image response ingredients
// (The "vision" path reuses macros already computed by the AI in the analyze-image flow)
function extractAIMacros(ingredient: IngredientWithQuantity): {
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
} | null {
  // If upstream feature already computed macros and embedded them (extended IngredientWithQuantity),
  // use them directly. Otherwise return null to trigger DB fallback.
  const extended = ingredient as IngredientWithQuantity & {
    calories_kcal?: number;
    protein_g?: number;
    carbs_g?: number;
    fat_g?: number;
  };
  if (
    typeof extended.calories_kcal === "number" &&
    extended.calories_kcal > 0
  ) {
    return {
      calories_kcal: extended.calories_kcal,
      protein_g: extended.protein_g ?? 0,
      carbs_g: extended.carbs_g ?? 0,
      fat_g: extended.fat_g ?? 0,
    };
  }
  return null;
}

/**
 * Calculate nutritional values for a list of ingredients with known quantities.
 *
 * Strategy:
 * 1. For each ingredient: try AI-provided macros first (source="vision")
 * 2. Fallback to nutritional DB lookup (source="database" or "estimated_generic")
 * 3. Consolidate duplicates
 * 4. Validate ranges and consistency
 * 5. Calculate meal totals
 * 6. Mark all values as editable=true
 */
export async function calculateCalories(
  mealId: string,
  ingredients: IngredientWithQuantity[],
): Promise<CalorieCalculationResult> {
  if (!ingredients.length) {
    return {
      meal_id: mealId,
      ingredients: [],
      totals: {
        total_weight_g: 0,
        total_calories_kcal: 0,
        total_protein_g: 0,
        total_carbs_g: 0,
        total_fat_g: 0,
      },
      warnings: [],
      estimated_generic_ratio: 0,
      calculated_at: new Date().toISOString(),
    };
  }

  const warnings: CalorieCalculationWarning[] = [];
  const rawResults: CalculatedIngredient[] = [];

  for (const ing of ingredients) {
    const aiMacros = extractAIMacros(ing);
    let calculatedSource: CalculatedIngredient["source"];
    let calcMacros: {
      calories_kcal: number;
      protein_g: number;
      carbs_g: number;
      fat_g: number;
    };
    let aiCaloriesKcal: number | undefined;
    let dbCaloriesKcal: number | undefined;
    let discrepancyDetected = false;

    if (aiMacros && aiMacros.calories_kcal > 0) {
      // Use AI-provided macros (vision source)
      calcMacros = aiMacros;
      calculatedSource = "vision";
      aiCaloriesKcal = aiMacros.calories_kcal;

      // Discrepancy check: compare with DB reference
      const dbNutrition = await lookupNutritionalData(ing.name);
      const dbMacros = calculateMacros(ing.quantity_g, dbNutrition);
      dbCaloriesKcal = dbMacros.calories_kcal;
      discrepancyDetected = detectDiscrepancy(aiCaloriesKcal, dbCaloriesKcal);

      if (discrepancyDetected) {
        warnings.push({
          type: "discrepancy_detected",
          ingredient_name: ing.name,
          message: `Discrepancia en "${ing.name}": IA ${aiCaloriesKcal.toFixed(1)} kcal vs BD ${dbCaloriesKcal.toFixed(1)} kcal (diferencia >20%)`,
        });
      }
    } else {
      // Fallback to nutritional DB
      const dbNutrition = await lookupNutritionalData(ing.name);
      calcMacros = calculateMacros(ing.quantity_g, dbNutrition);
      dbCaloriesKcal = calcMacros.calories_kcal;

      // Determine source from DB lookup result
      // If default fallback was used (all values are the defaults), mark estimated_generic
      const isGeneric =
        dbNutrition.calories === 150 &&
        dbNutrition.protein === 5 &&
        dbNutrition.carbs === 20 &&
        dbNutrition.fat === 5;
      calculatedSource = isGeneric ? "estimated_generic" : "database";

      if (calculatedSource === "estimated_generic") {
        warnings.push({
          type: "estimated_generic",
          ingredient_name: ing.name,
          message: `"${ing.name}" no encontrado en base de datos. Usando valores aproximados por categoría.`,
        });
      }
    }

    rawResults.push({
      name: ing.name,
      quantity_g: ing.quantity_g,
      confidence: ing.confidence,
      source: calculatedSource,
      editable: true,
      calories_kcal: Math.round(calcMacros.calories_kcal * 100) / 100,
      protein_g: Math.round(calcMacros.protein_g * 100) / 100,
      carbs_g: Math.round(calcMacros.carbs_g * 100) / 100,
      fat_g: Math.round(calcMacros.fat_g * 100) / 100,
      nutrition_suspicious: false, // will be set after totals check
      allergen: false,
      allergen_list: [],
      dietary_type: undefined,
      discrepancy_detected: discrepancyDetected,
      ai_calories_kcal: aiCaloriesKcal,
      db_calories_kcal: dbCaloriesKcal,
    });
  }

  // Consolidate duplicates
  const consolidated = consolidateDuplicates(rawResults);

  // Validate non-negative values (throws if violated — contract invariant 3)
  validateNonNegative(consolidated);

  // Check per-ingredient consistency
  for (const ing of consolidated) {
    checkConsistency(ing, warnings);
  }

  // Build low-confidence warnings
  buildLowConfidenceWarnings(consolidated, warnings);

  // Calculate totals
  const totals: CalorieCalculationTotals = consolidated.reduce(
    (acc, ing) => ({
      total_weight_g: acc.total_weight_g + ing.quantity_g,
      total_calories_kcal: acc.total_calories_kcal + ing.calories_kcal,
      total_protein_g: acc.total_protein_g + ing.protein_g,
      total_carbs_g: acc.total_carbs_g + ing.carbs_g,
      total_fat_g: acc.total_fat_g + ing.fat_g,
    }),
    {
      total_weight_g: 0,
      total_calories_kcal: 0,
      total_protein_g: 0,
      total_carbs_g: 0,
      total_fat_g: 0,
    },
  );

  // Round totals
  totals.total_calories_kcal =
    Math.round(totals.total_calories_kcal * 100) / 100;
  totals.total_protein_g = Math.round(totals.total_protein_g * 100) / 100;
  totals.total_carbs_g = Math.round(totals.total_carbs_g * 100) / 100;
  totals.total_fat_g = Math.round(totals.total_fat_g * 100) / 100;
  totals.total_weight_g = Math.round(totals.total_weight_g * 100) / 100;

  // Flag suspicious meal-level values (BR-014)
  const mealSuspicious = flagSuspiciousValues(
    totals.total_calories_kcal,
    totals.total_protein_g,
    warnings,
  );
  if (mealSuspicious) {
    // Mark all ingredients as suspicious at meal level
    for (const ing of consolidated) {
      ing.nutrition_suspicious = true;
    }
  }

  // Estimated generic ratio (BR-015: >50% estimated_generic → show warning)
  const estimatedGenericCount = consolidated.filter(
    (i) => i.source === "estimated_generic",
  ).length;
  const estimatedGenericRatio =
    consolidated.length > 0 ? estimatedGenericCount / consolidated.length : 0;

  if (estimatedGenericRatio > 0.5) {
    warnings.push({
      type: "estimated_generic",
      message: `Más del 50% de ingredientes usan valores aproximados. Los resultados son orientativos.`,
    });
  }

  return {
    meal_id: mealId,
    ingredients: consolidated,
    totals,
    warnings,
    estimated_generic_ratio: Math.round(estimatedGenericRatio * 100) / 100,
    calculated_at: new Date().toISOString(),
  };
}
