// Nutritional reference data service — feature 007
// Looks up macro values per 100g for a given ingredient name.
// Strategy: 1) exact name match (case-insensitive), 2) alias match, 3) category average fallback
// NOTE: Requires `prisma migrate dev` + `prisma generate` to activate nutritional_reference table queries.

import { prisma } from "../lib/prisma.js";
import type { NutritionPer100g } from "../types/estimateQuantities.types.js";

type NutritionalRow = {
  id: string;
  name: string;
  category: string;
  calories_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
};

// Category average fallbacks (approximate values for Spanish Mediterranean diet)
const CATEGORY_FALLBACKS: Record<string, NutritionPer100g> = {
  cereales: { calories: 350, protein: 9, carbs: 72, fat: 2 },
  proteinas: { calories: 165, protein: 25, carbs: 0, fat: 6 },
  lacteos: { calories: 120, protein: 7, carbs: 10, fat: 5 },
  frutas: { calories: 55, protein: 1, carbs: 13, fat: 0.3 },
  verduras: { calories: 35, protein: 2, carbs: 6, fat: 0.3 },
  grasas: { calories: 700, protein: 1, carbs: 2, fat: 75 },
  salsas: { calories: 150, protein: 2, carbs: 15, fat: 9 },
  otros: { calories: 200, protein: 5, carbs: 25, fat: 8 },
};

const DEFAULT_FALLBACK: NutritionPer100g = {
  calories: 150,
  protein: 5,
  carbs: 20,
  fat: 5,
};

function rowToNutrition(row: NutritionalRow): NutritionPer100g {
  return {
    calories: row.calories_per_100g,
    protein: row.protein_per_100g,
    carbs: row.carbs_per_100g,
    fat: row.fat_per_100g,
  };
}

export async function lookupNutritionalData(
  name: string,
): Promise<NutritionPer100g> {
  const normalized = name.trim().toLowerCase();

  try {
    // 1. Exact name match (case-insensitive)
    const exactRows = await prisma.$queryRaw<NutritionalRow[]>`
      SELECT id, name, category, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g
      FROM nutritional_reference
      WHERE LOWER(name) = ${normalized}
      LIMIT 1
    `;
    if (exactRows.length > 0) return rowToNutrition(exactRows[0]);

    // 2. Alias match — PostgreSQL array contains
    const aliasRows = await prisma.$queryRaw<NutritionalRow[]>`
      SELECT id, name, category, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g
      FROM nutritional_reference
      WHERE ${normalized} = ANY(aliases)
      LIMIT 1
    `;
    if (aliasRows.length > 0) return rowToNutrition(aliasRows[0]);

    // 3. Category fallback — partial name match → return category average
    const categoryRows = await prisma.$queryRaw<
      Pick<NutritionalRow, "category">[]
    >`
      SELECT category
      FROM nutritional_reference
      WHERE LOWER(name) LIKE ${"%" + normalized.split(" ")[0] + "%"}
      LIMIT 1
    `;
    if (categoryRows.length > 0) {
      const fallback =
        CATEGORY_FALLBACKS[categoryRows[0].category.toLowerCase()];
      if (fallback) return fallback;
    }
  } catch {
    // Table may not exist yet (pre-migration). Return default fallback.
  }

  return DEFAULT_FALLBACK;
}

export function calculateMacros(
  quantityG: number,
  nutrition: NutritionPer100g,
): {
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
} {
  const factor = quantityG / 100;
  return {
    calories_kcal: Math.round(nutrition.calories * factor * 100) / 100,
    protein_g: Math.round(nutrition.protein * factor * 100) / 100,
    carbs_g: Math.round(nutrition.carbs * factor * 100) / 100,
    fat_g: Math.round(nutrition.fat * factor * 100) / 100,
  };
}
