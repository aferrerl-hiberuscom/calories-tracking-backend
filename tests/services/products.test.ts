// Feature 026 — pure unit tests: barcode normalization (D-BAR-10), energy
// coherence (BR-026-01) and meals payload accepting source=PRODUCT (013 v2.2.0).

import { describe, expect, it } from "vitest";
import { normalizeBarcode } from "../../src/lib/barcode";
import { macrosAreCoherent } from "../../src/services/products.service";
import { validateMealPayload } from "../../src/services/meals/validateMealPayload";

describe("normalizeBarcode (D-BAR-10)", () => {
  it("keeps EAN-13 as-is", () => {
    expect(normalizeBarcode("8410100012345")).toBe("8410100012345");
  });

  it("keeps EAN-8 as-is", () => {
    expect(normalizeBarcode("12345678")).toBe("12345678");
  });

  it("left-pads UPC-A (12 digits) to EAN-13", () => {
    expect(normalizeBarcode("036000291452")).toBe("0036000291452");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeBarcode("  8410100012345 ")).toBe("8410100012345");
  });

  it.each([
    ["too short", "1234567"],
    ["unsupported length", "123456789"],
    ["too long", "84101000123456"],
    ["non-digits", "84101A0012345"],
    ["empty", ""],
  ])("rejects %s", (_label, input) => {
    expect(normalizeBarcode(input)).toBeNull();
  });
});

describe("macrosAreCoherent (BR-026-01)", () => {
  it("accepts coherent macros (yogur natural)", () => {
    // 4·3.5 + 4·4.7 + 9·3.3 = 62.5 ≈ 61 kcal
    expect(
      macrosAreCoherent({
        calories_kcal_100g: 61,
        protein_g_100g: 3.5,
        carbs_g_100g: 4.7,
        fat_g_100g: 3.3,
      }),
    ).toBe(true);
  });

  it("rejects kcal far above the macro estimate (>±30%)", () => {
    expect(
      macrosAreCoherent({
        calories_kcal_100g: 500,
        protein_g_100g: 3.5,
        carbs_g_100g: 4.7,
        fat_g_100g: 3.3,
      }),
    ).toBe(false);
  });

  it("rejects kcal far below the macro estimate", () => {
    expect(
      macrosAreCoherent({
        calories_kcal_100g: 10,
        protein_g_100g: 25,
        carbs_g_100g: 50,
        fat_g_100g: 20,
      }),
    ).toBe(false);
  });

  it("accepts water-like products (all zeros)", () => {
    expect(
      macrosAreCoherent({
        calories_kcal_100g: 0,
        protein_g_100g: 0,
        carbs_g_100g: 0,
        fat_g_100g: 0,
      }),
    ).toBe(true);
  });
});

describe("validateMealPayload accepts source=PRODUCT (013 v2.2.0)", () => {
  it("validates a product meal payload", () => {
    const result = validateMealPayload({
      name: "Yogur natural",
      meal_date: new Date().toISOString(),
      total_weight_g: 125,
      calories_kcal: 76.25,
      protein_g: 4.38,
      carbs_g: 5.88,
      fat_g: 4.13,
      ingredients: [
        {
          name: "Yogur natural",
          quantity_g: 125,
          source: "PRODUCT",
          calories_kcal: 76.25,
          protein_g: 4.38,
          carbs_g: 5.88,
          fat_g: 4.13,
        },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("still rejects unknown sources", () => {
    const result = validateMealPayload({
      name: "X",
      meal_date: new Date().toISOString(),
      total_weight_g: 100,
      calories_kcal: 100,
      protein_g: 0,
      carbs_g: 25,
      fat_g: 0,
      ingredients: [
        {
          name: "X",
          quantity_g: 100,
          source: "BARCODE",
          calories_kcal: 100,
          protein_g: 0,
          carbs_g: 25,
          fat_g: 0,
        },
      ],
    });
    expect(result.valid).toBe(false);
  });
});
