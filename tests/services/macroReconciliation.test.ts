// Hybrid DB-macros reconciliation — unit tests (injected lookup, no DB).
// Rule under test: a REAL catalog match (exact/alias or LLM catalog_name)
// overrides AI macros with per-100g DB values scaled by quantity_g; anything
// else keeps the AI-estimated macros untouched.

import { describe, expect, it } from "vitest";
import { reconcileMacrosWithDb } from "../../src/services/analyze-image.service";
import type {
  IngredientResult,
  MacroLookupFn,
} from "../../src/services/analyze-image.service";
import type { DetailedNutritionLookup } from "../../src/services/nutritionalData.service";

function makeIngredient(
  overrides: Partial<IngredientResult> = {},
): IngredientResult {
  return {
    name: "ingrediente",
    quantity_g: 100,
    source: "INFERRED",
    confidence: 0.9,
    cooking_method: "UNKNOWN",
    calories_kcal: 111,
    protein_g: 11,
    carbs_g: 11,
    fat_g: 11,
    ...overrides,
  };
}

/** Fake DB: matches only the given canonical names (per-100g values). */
function makeLookup(
  db: Record<string, { calories: number; protein: number; carbs: number; fat: number }>,
): MacroLookupFn {
  return async (name: string): Promise<DetailedNutritionLookup> => {
    const hit = db[name];
    if (hit) return { nutrition: hit, matched: true, matchedName: name };
    return {
      nutrition: { calories: 150, protein: 5, carbs: 20, fat: 5 },
      matched: false,
    };
  };
}

describe("reconcileMacrosWithDb", () => {
  it("recalculates macros from DB via LLM catalog_name (semantic match)", async () => {
    const lookup = makeLookup({
      "Hamburguesa de ternera": { calories: 254, protein: 17.2, carbs: 0, fat: 20.3 },
    });
    const ing = makeIngredient({ name: "beef burger", quantity_g: 150 });

    const { ingredients, matches } = await reconcileMacrosWithDb(
      [ing],
      () => "Hamburguesa de ternera",
      lookup,
    );

    expect(matches).toBe(1);
    expect(ingredients[0].calories_kcal).toBeCloseTo(381, 1); // 254 × 1.5
    expect(ingredients[0].protein_g).toBeCloseTo(25.8, 1);
    expect(ingredients[0].fat_g).toBeCloseTo(30.45, 2);
  });

  it("falls back to the ingredient's own name when catalog_name is absent", async () => {
    const lookup = makeLookup({
      arroz: { calories: 130, protein: 2.7, carbs: 28.2, fat: 0.3 },
    });
    const ing = makeIngredient({ name: "arroz", quantity_g: 200 });

    const { ingredients, matches } = await reconcileMacrosWithDb(
      [ing],
      () => undefined,
      lookup,
    );

    expect(matches).toBe(1);
    expect(ingredients[0].calories_kcal).toBeCloseTo(260, 1);
    expect(ingredients[0].carbs_g).toBeCloseTo(56.4, 1);
  });

  it("keeps AI macros untouched when nothing really matches (fallback is not a match)", async () => {
    const lookup = makeLookup({}); // everything resolves to unmatched fallback
    const ing = makeIngredient({
      name: "pipas de girasol",
      quantity_g: 50,
      calories_kcal: 292,
      protein_g: 10.4,
      carbs_g: 10,
      fat_g: 25.7,
    });

    const { ingredients, matches } = await reconcileMacrosWithDb(
      [ing],
      () => undefined,
      lookup,
    );

    expect(matches).toBe(0);
    expect(ingredients[0]).toEqual(ing); // AI estimates preserved verbatim
  });

  it("prefers catalog_name over the raw name and skips zero-quantity ingredients", async () => {
    const lookup = makeLookup({
      "Pechuga de pollo a la plancha": { calories: 165, protein: 31, carbs: 0, fat: 3.6 },
      pollo: { calories: 999, protein: 99, carbs: 99, fat: 99 }, // must NOT be used
    });
    const matched = makeIngredient({ name: "pollo", quantity_g: 100 });
    const zeroQty = makeIngredient({ name: "pollo", quantity_g: 0, calories_kcal: 42 });

    const { ingredients, matches } = await reconcileMacrosWithDb(
      [matched, zeroQty],
      () => "Pechuga de pollo a la plancha",
      lookup,
    );

    expect(matches).toBe(1);
    expect(ingredients[0].calories_kcal).toBeCloseTo(165, 1); // catalog entry wins
    expect(ingredients[1].calories_kcal).toBe(42); // zero-qty left untouched
  });
});
