/**
 * TASK-013-10: Unit tests for validateMealPayload
 *
 * Tests every validation rule defined in validateMealPayload.ts including:
 * - Valid payload → { valid: true, errors: [] }
 * - Missing / empty ingredients array
 * - Ingredient name length boundaries (120 char limit)
 * - quantity_g rules (must be > 0)
 * - Negative macro rejection
 * - Totals coherence check (±0.01 tolerance)
 * - Invalid and valid IngredientSource enum values
 */

import { describe, it, expect } from "vitest";
import { validateMealPayload } from "../validateMealPayload";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeIngredient(overrides: Record<string, unknown> = {}) {
  return {
    name: "Arroz blanco",
    quantity_g: 150,
    source: "VISIBLE",
    calories_kcal: 195,
    protein_g: 4.1,
    carbs_g: 43,
    fat_g: 0.4,
    ...overrides,
  };
}

function makePayload(overrides: Record<string, unknown> = {}, ingredientOverrides: Record<string, unknown> = {}) {
  const ingredient = makeIngredient(ingredientOverrides);
  const base = {
    image_url: "uploads/test-image.jpg",
    meal_date: "2026-06-05T12:00:00.000Z",
    total_weight_g: ingredient.quantity_g as number,
    calories_kcal: ingredient.calories_kcal as number,
    protein_g: ingredient.protein_g as number,
    carbs_g: ingredient.carbs_g as number,
    fat_g: ingredient.fat_g as number,
    ingredients: [ingredient],
  };
  return { ...base, ...overrides };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("validateMealPayload — valid payload", () => {
  it("returns valid:true and empty errors array for a correct payload", () => {
    const result = validateMealPayload(makePayload());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe("validateMealPayload — ingredients array", () => {
  it("returns valid:false when ingredients field is missing", () => {
    const payload = makePayload();
    // biome-ignore lint: intentionally removing ingredients
    delete (payload as Record<string, unknown>).ingredients;
    const result = validateMealPayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("ingredients"))).toBe(true);
  });

  it("returns valid:false when ingredients is not an array (string)", () => {
    const result = validateMealPayload(makePayload({ ingredients: "not-an-array" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("ingredients"))).toBe(true);
  });

  it("returns valid:false when ingredients array is empty", () => {
    const result = validateMealPayload(makePayload({ ingredients: [] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("at least 1"))).toBe(true);
  });
});

describe("validateMealPayload — ingredient name length", () => {
  it("returns valid:false when ingredient name is empty string", () => {
    const result = validateMealPayload(makePayload({}, { name: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes(".name"))).toBe(true);
  });

  it("returns valid:false when ingredient name is 121 characters", () => {
    const name121 = "a".repeat(121);
    const result = validateMealPayload(makePayload({}, { name: name121 }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes(".name") && e.includes("120"))).toBe(true);
  });

  it("returns valid:true when ingredient name is exactly 120 characters", () => {
    const name120 = "a".repeat(120);
    const result = validateMealPayload(makePayload({}, { name: name120 }));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe("validateMealPayload — quantity_g rules", () => {
  it("returns valid:false when quantity_g is 0", () => {
    // quantity_g must be > 0; a 0 quantity_g also causes totals mismatch but the
    // primary error comes from the per-ingredient quantity_g check
    const result = validateMealPayload(
      makePayload({ total_weight_g: 0 }, { quantity_g: 0 }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("quantity_g") && e.includes("> 0"))).toBe(true);
  });

  it("returns valid:false when quantity_g is -1", () => {
    const result = validateMealPayload(
      makePayload({ total_weight_g: -1 }, { quantity_g: -1 }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("quantity_g") && e.includes("> 0"))).toBe(true);
  });
});

describe("validateMealPayload — negative macros", () => {
  it("returns valid:false when an ingredient has a negative calories_kcal", () => {
    const result = validateMealPayload(
      makePayload({ calories_kcal: -10 }, { calories_kcal: -10 }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("calories_kcal") && e.includes(">= 0"))).toBe(true);
  });

  it("returns valid:false when an ingredient has a negative protein_g", () => {
    // Adjust payload totals so the totals check does not introduce noise
    const result = validateMealPayload(
      makePayload({ protein_g: -1 }, { protein_g: -1 }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("protein_g") && e.includes(">= 0"))).toBe(true);
  });

  it("returns valid:false when an ingredient has a negative fat_g", () => {
    const result = validateMealPayload(
      makePayload({ fat_g: -0.5 }, { fat_g: -0.5 }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("fat_g") && e.includes(">= 0"))).toBe(true);
  });
});

describe("validateMealPayload — totals coherence", () => {
  it("returns valid:false when totals mismatch by more than 0.01", () => {
    // Ingredient has 195 kcal but payload claims 300 kcal (mismatch 105)
    const result = validateMealPayload(makePayload({ calories_kcal: 300 }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("calories_kcal"))).toBe(true);
  });

  it("returns valid:true when totals match within ±0.01 tolerance", () => {
    // calories_kcal differs by exactly 0.005 — within tolerance
    const result = validateMealPayload(makePayload({ calories_kcal: 195.005 }));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns valid:false when total_weight_g mismatches sum of quantity_g", () => {
    // ingredient has 150g but payload claims 200g total weight
    const result = validateMealPayload(makePayload({ total_weight_g: 200 }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("total_weight_g"))).toBe(true);
  });
});

describe("validateMealPayload — IngredientSource enum", () => {
  it("returns valid:false for an unrecognized source value", () => {
    const result = validateMealPayload(makePayload({}, { source: "UNKNOWN_SOURCE" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes(".source"))).toBe(true);
  });

  const validSources = ["VISIBLE", "INFERRED", "MANUAL", "ESTIMATED_GENERIC", "CONSOLIDATED", "MISSING"] as const;

  for (const source of validSources) {
    it(`returns valid:true for source = "${source}"`, () => {
      const result = validateMealPayload(makePayload({}, { source }));
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  }

  it("accepts source values case-insensitively (lowercase visible)", () => {
    const result = validateMealPayload(makePayload({}, { source: "visible" }));
    expect(result.valid).toBe(true);
  });
});
