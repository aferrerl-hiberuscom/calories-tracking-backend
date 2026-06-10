// Types for feature 007 — Estimate Quantities
// Matches contract_spec.md section 3.x

export type IngredientSource =
  | "VISIBLE"
  | "INFERRED"
  | "MANUAL"
  | "ESTIMATED_GENERIC"
  | "CONSOLIDATED"
  | "MISSING";

export type WarningType =
  | "low_confidence"
  | "out_of_range"
  | "missing_ingredient"
  | "generic_estimate";

export type MacroNutrients = {
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

export type IngredientInput = {
  name: string;
  confidence?: number;
  source?: string;
};

export type EstimateQuantitiesRequest = {
  meal_id: string;
  image_url?: string;
  ingredients: IngredientInput[];
};

export type IngredientEstimate = {
  id?: string;
  name: string;
  quantity_g: number;
  confidence: number;
  source: IngredientSource;
  quantity_suspicious: boolean;
  macros: MacroNutrients;
};

export type QuantityWarning = {
  type: WarningType;
  ingredient_name: string;
  message: string;
};

export type EstimateQuantitiesResponse = {
  meal_id: string;
  estimated_at: string;
  ingredients: IngredientEstimate[];
  total_weight_g: number;
  warnings: QuantityWarning[];
};

export type UpdateQuantityRequest = {
  quantity_g: number;
};

export type UpdateQuantityResponse = {
  ingredient_id: string;
  meal_id: string;
  name: string;
  quantity_g: number;
  source: "MANUAL";
  confidence: 1.0;
  macros: MacroNutrients;
  updated_at: string;
};

export type NutritionPer100g = {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
};
