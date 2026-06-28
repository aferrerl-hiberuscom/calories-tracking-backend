// Food catalog for Feature 011 ingredient editing.
// Representative average nutritional values per 100g for each food type category.
// These are used by the nutrition lookup endpoint to support real-time recalculation.

export const FOOD_TYPES = [
  "Meat",
  "Poultry",
  "Fish",
  "Grain",
  "Legume",
  "Vegetable",
  "Fruit",
  "Dairy",
  "Oil/Fat",
  "Beverage",
  "Processed",
] as const;

export type FoodType = (typeof FOOD_TYPES)[number];

export type NutritionPer100g = {
  calories_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
};

// Average representative values per 100g, sourced from USDA / BEDCA averages per category.
const CATALOG: Record<FoodType, NutritionPer100g> = {
  Meat:      { calories_per_100g: 220, protein_per_100g: 25.0, carbs_per_100g: 0.0,  fat_per_100g: 12.0 },
  Poultry:   { calories_per_100g: 170, protein_per_100g: 27.0, carbs_per_100g: 0.0,  fat_per_100g: 7.0  },
  Fish:      { calories_per_100g: 140, protein_per_100g: 22.0, carbs_per_100g: 0.0,  fat_per_100g: 5.0  },
  Grain:     { calories_per_100g: 130, protein_per_100g: 4.0,  carbs_per_100g: 27.0, fat_per_100g: 0.5  },
  Legume:    { calories_per_100g: 120, protein_per_100g: 9.0,  carbs_per_100g: 22.0, fat_per_100g: 0.5  },
  Vegetable: { calories_per_100g: 30,  protein_per_100g: 2.0,  carbs_per_100g: 6.0,  fat_per_100g: 0.3  },
  Fruit:     { calories_per_100g: 55,  protein_per_100g: 0.8,  carbs_per_100g: 14.0, fat_per_100g: 0.2  },
  Dairy:     { calories_per_100g: 100, protein_per_100g: 6.0,  carbs_per_100g: 5.0,  fat_per_100g: 6.0  },
  "Oil/Fat": { calories_per_100g: 750, protein_per_100g: 0.5,  carbs_per_100g: 1.0,  fat_per_100g: 83.0 },
  Beverage:  { calories_per_100g: 40,  protein_per_100g: 0.3,  carbs_per_100g: 9.0,  fat_per_100g: 0.0  },
  Processed: { calories_per_100g: 280, protein_per_100g: 10.0, carbs_per_100g: 30.0, fat_per_100g: 12.0 },
};

export function isFoodType(value: string): value is FoodType {
  return (FOOD_TYPES as readonly string[]).includes(value);
}

export function lookupFoodType(foodType: string): NutritionPer100g | null {
  if (!isFoodType(foodType)) return null;
  return CATALOG[foodType];
}
