/**
 * Pure validation function for the POST /api/v1/meals payload (Feature 013).
 * No side effects. Collects all violations before returning.
 */

// Valid source values as defined in schema.prisma IngredientSource enum
const VALID_SOURCES = [
  "VISIBLE",
  "INFERRED",
  "MANUAL",
  "ESTIMATED_GENERIC",
  "CONSOLIDATED",
  "MISSING",
  // Contract 013 v2.2.0 (A-013-06): macros defined by a barcode-resolved Product.
  "PRODUCT",
] as const;

export type ValidSource = (typeof VALID_SOURCES)[number];

export interface IngredientPayload {
  name: string;
  quantity_g: number;
  source: string;
  cooking_method?: string | null;
  confidence?: number | null;
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

export interface MealPayload {
  // Contract 013 v2.1.0 (A-013-05): optional — manual creation (C3 → empty A6,
  // D-BROTE-03) saves without a photo. When present it must be non-empty.
  image_url?: string;
  // Contract 013 v2.0.0 (A-013-01): dish name, required, 1..120 chars.
  name: string;
  meal_date: string;
  total_weight_g: number;
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  ingredients: IngredientPayload[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && !Number.isNaN(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

export function validateMealPayload(payload: unknown): ValidationResult {
  const errors: string[] = [];

  if (payload === null || typeof payload !== "object") {
    return { valid: false, errors: ["Payload must be a non-null object"] };
  }

  const p = payload as Record<string, unknown>;

  // image_url — optional since contract 013 v2.1.0 (manual creation has no
  // photo); when present it must still be a non-empty reference.
  if (p.image_url !== undefined) {
    if (!isString(p.image_url) || p.image_url.trim().length === 0) {
      errors.push("image_url, when present, must be a non-empty string");
    }
  }

  // name — contract 013 v2.0.0 (A-013-01): required, 1..120 chars
  if (!isString(p.name) || p.name.trim().length === 0) {
    errors.push("name is required and must be a non-empty string");
  } else if (p.name.length > 120) {
    errors.push("name must not exceed 120 characters");
  }

  // meal_date
  if (!isString(p.meal_date) || p.meal_date.trim().length === 0) {
    errors.push("meal_date is required and must be a non-empty ISO-8601 string");
  } else if (Number.isNaN(Date.parse(p.meal_date))) {
    errors.push("meal_date must be a valid ISO-8601 timestamp");
  }

  // Meal-level macro fields
  const mealMacros = ["total_weight_g", "calories_kcal", "protein_g", "carbs_g", "fat_g"] as const;
  for (const field of mealMacros) {
    const val = p[field];
    if (!isNumber(val)) {
      errors.push(`${field} is required and must be a number`);
    } else if (val < 0) {
      errors.push(`${field} must be >= 0`);
    }
  }

  // ingredients array
  if (!Array.isArray(p.ingredients)) {
    errors.push("ingredients must be an array");
    return { valid: errors.length === 0, errors };
  }

  const ingredients = p.ingredients as unknown[];

  if (ingredients.length < 1) {
    errors.push("ingredients must contain at least 1 element");
  }

  // Per-ingredient totals accumulators
  let sumCalories = 0;
  let sumProtein = 0;
  let sumCarbs = 0;
  let sumFat = 0;
  let sumWeight = 0;

  for (let i = 0; i < ingredients.length; i++) {
    const ing = ingredients[i];
    const prefix = `ingredients[${i}]`;

    if (ing === null || typeof ing !== "object") {
      errors.push(`${prefix} must be a non-null object`);
      continue;
    }

    const item = ing as Record<string, unknown>;

    // name: 1..120 chars
    if (!isString(item.name)) {
      errors.push(`${prefix}.name is required and must be a string`);
    } else if (item.name.length < 1) {
      errors.push(`${prefix}.name must be at least 1 character`);
    } else if (item.name.length > 120) {
      errors.push(`${prefix}.name must not exceed 120 characters`);
    }

    // quantity_g > 0
    if (!isNumber(item.quantity_g)) {
      errors.push(`${prefix}.quantity_g is required and must be a number`);
    } else if (item.quantity_g <= 0) {
      errors.push(`${prefix}.quantity_g must be > 0`);
    } else {
      sumWeight += item.quantity_g;
    }

    // source enum
    if (!isString(item.source)) {
      errors.push(`${prefix}.source is required and must be a string`);
    } else if (!(VALID_SOURCES as readonly string[]).includes(item.source.toUpperCase())) {
      errors.push(
        `${prefix}.source must be one of: ${VALID_SOURCES.join(", ")} (case-insensitive)`
      );
    }

    // Per-ingredient macros >= 0
    const ingMacros = ["calories_kcal", "protein_g", "carbs_g", "fat_g"] as const;
    for (const field of ingMacros) {
      const val = item[field];
      if (!isNumber(val)) {
        errors.push(`${prefix}.${field} is required and must be a number`);
      } else if (val < 0) {
        errors.push(`${prefix}.${field} must be >= 0`);
      } else {
        // Accumulate only when valid
        if (field === "calories_kcal") sumCalories += val;
        else if (field === "protein_g") sumProtein += val;
        else if (field === "carbs_g") sumCarbs += val;
        else if (field === "fat_g") sumFat += val;
      }
    }
  }

  // Totals coherence check (±0.01 tolerance) — only when meal-level fields are valid numbers
  const TOLERANCE = 0.01;

  if (
    isNumber(p.calories_kcal) &&
    p.calories_kcal >= 0 &&
    Math.abs(p.calories_kcal - sumCalories) > TOLERANCE
  ) {
    errors.push(
      `calories_kcal (${p.calories_kcal}) must equal the sum of ingredients' calories_kcal (${sumCalories.toFixed(4)}) within ±${TOLERANCE}`
    );
  }

  if (
    isNumber(p.protein_g) &&
    p.protein_g >= 0 &&
    Math.abs(p.protein_g - sumProtein) > TOLERANCE
  ) {
    errors.push(
      `protein_g (${p.protein_g}) must equal the sum of ingredients' protein_g (${sumProtein.toFixed(4)}) within ±${TOLERANCE}`
    );
  }

  if (
    isNumber(p.carbs_g) &&
    p.carbs_g >= 0 &&
    Math.abs(p.carbs_g - sumCarbs) > TOLERANCE
  ) {
    errors.push(
      `carbs_g (${p.carbs_g}) must equal the sum of ingredients' carbs_g (${sumCarbs.toFixed(4)}) within ±${TOLERANCE}`
    );
  }

  if (
    isNumber(p.fat_g) &&
    p.fat_g >= 0 &&
    Math.abs(p.fat_g - sumFat) > TOLERANCE
  ) {
    errors.push(
      `fat_g (${p.fat_g}) must equal the sum of ingredients' fat_g (${sumFat.toFixed(4)}) within ±${TOLERANCE}`
    );
  }

  if (
    isNumber(p.total_weight_g) &&
    p.total_weight_g >= 0 &&
    Math.abs(p.total_weight_g - sumWeight) > TOLERANCE
  ) {
    errors.push(
      `total_weight_g (${p.total_weight_g}) must equal the sum of ingredients' quantity_g (${sumWeight.toFixed(4)}) within ±${TOLERANCE}`
    );
  }

  return { valid: errors.length === 0, errors };
}
