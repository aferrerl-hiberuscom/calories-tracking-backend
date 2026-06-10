// Types for feature 008 — Calorie Calculation
// Matches contract_spec.md: Inputs and Outputs section

export type IngredientWithQuantity = {
  name: string;
  quantity_g: number;
  confidence: number;
  source: string;
};

export type NutritionalValues = {
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

export type CalculatedIngredient = {
  name: string;
  quantity_g: number;
  confidence: number;
  source: "vision" | "database" | "heuristic" | "manual" | "estimated_generic";
  editable: true;
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  nutrition_suspicious: boolean;
  allergen: boolean;
  allergen_list: string[];
  dietary_type?: string;
  discrepancy_detected: boolean;
  ai_calories_kcal?: number;
  db_calories_kcal?: number;
};

export type CalorieCalculationTotals = {
  total_weight_g: number;
  total_calories_kcal: number;
  total_protein_g: number;
  total_carbs_g: number;
  total_fat_g: number;
};

export type CalorieCalculationResult = {
  meal_id: string;
  ingredients: CalculatedIngredient[];
  totals: CalorieCalculationTotals;
  warnings: CalorieCalculationWarning[];
  dietary_type?: string;
  estimated_generic_ratio: number;
  calculated_at: string;
};

export type CalorieCalculationWarning = {
  type:
    | "nutrition_suspicious"
    | "low_confidence"
    | "estimated_generic"
    | "consistency_mismatch"
    | "discrepancy_detected";
  ingredient_name?: string;
  message: string;
};

export type CalorieCalculationRequest = {
  meal_id: string;
  image_url: string;
  ingredients: IngredientWithQuantity[];
};
