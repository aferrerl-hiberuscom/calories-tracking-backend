// Nutritional reference data service — feature 007
// Looks up macro values per 100g for a given ingredient name.
// Strategy: 1) exact name match (case-insensitive), 2) alias match, 3) category average fallback
// NOTE: Requires `prisma migrate dev` + `prisma generate` to activate nutritional_reference table queries.

import { prisma } from "../lib/prisma";
import type { NutritionPer100g } from "../types/estimateQuantities.types";

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

export type DetailedNutritionLookup = {
  nutrition: NutritionPer100g;
  /**
   * true ONLY for a real catalog hit (exact name or alias). Category averages
   * and the default fallback report false — callers use this to decide whether
   * DB values are trustworthy enough to override AI-estimated macros.
   */
  matched: boolean;
  /** Canonical catalog name when matched. */
  matchedName?: string;
};

export async function lookupNutritionalDataDetailed(
  name: string,
): Promise<DetailedNutritionLookup> {
  const normalized = name.trim().toLowerCase();

  // Typed Prisma client, NOT raw SQL: the physical columns are camelCase
  // ("caloriesPer100g" — the model has no @map on fields), so the original
  // snake_case raw queries always errored and fell through to the fallback.
  try {
    // 1. Exact name match (case-insensitive)
    const exact = await prisma.nutritionalReference.findFirst({
      where: { name: { equals: normalized, mode: "insensitive" } },
    });
    if (exact) {
      return {
        nutrition: {
          calories: exact.caloriesPer100g,
          protein: exact.proteinPer100g,
          carbs: exact.carbsPer100g,
          fat: exact.fatPer100g,
        },
        matched: true,
        matchedName: exact.name,
      };
    }

    // 2. Alias match — aliases are stored lowercase
    const aliased = await prisma.nutritionalReference.findFirst({
      where: { aliases: { has: normalized } },
    });
    if (aliased) {
      return {
        nutrition: {
          calories: aliased.caloriesPer100g,
          protein: aliased.proteinPer100g,
          carbs: aliased.carbsPer100g,
          fat: aliased.fatPer100g,
        },
        matched: true,
        matchedName: aliased.name,
      };
    }

    // 3. Category fallback — partial name match → return category average
    const firstWord = normalized.split(" ")[0] ?? "";
    if (firstWord) {
      const categoryRow = await prisma.nutritionalReference.findFirst({
        where: { name: { contains: firstWord, mode: "insensitive" } },
        select: { category: true },
      });
      if (categoryRow) {
        const fallback = CATEGORY_FALLBACKS[categoryRow.category.toLowerCase()];
        if (fallback) return { nutrition: fallback, matched: false };
      }
    }
  } catch {
    // Table may not exist yet (pre-migration). Return default fallback.
  }

  return { nutrition: DEFAULT_FALLBACK, matched: false };
}

export async function lookupNutritionalData(
  name: string,
): Promise<NutritionPer100g> {
  return (await lookupNutritionalDataDetailed(name)).nutrition;
}

// ─── Catalog names (for LLM canonical mapping) ───────────────────────────────

let catalogCache: { names: string[]; fetchedAt: number } | null = null;
const CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * All canonical names from nutritional_reference, cached in memory (10 min TTL).
 * Injected into the vision prompt so the LLM can map each detected ingredient
 * to a catalog entry (semantic matching: synonyms/translations). Returns [] if
 * the table is missing or empty — callers then simply skip catalog mapping.
 */
export async function getNutritionalCatalogNames(): Promise<string[]> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return catalogCache.names;
  }

  try {
    const rows = await prisma.nutritionalReference.findMany({
      select: { name: true },
      orderBy: { name: "asc" },
    });
    catalogCache = { names: rows.map((r) => r.name), fetchedAt: now };
    return catalogCache.names;
  } catch {
    // Table may not exist yet — serve stale cache if any, else empty.
    return catalogCache?.names ?? [];
  }
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
