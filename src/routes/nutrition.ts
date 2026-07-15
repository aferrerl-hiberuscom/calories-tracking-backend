import { Router } from "express";
import { z } from "zod";
import { ApiError } from "../middleware/api-error";
import { requireAuth, getRequiredUserId } from "../middleware/auth";
import {
  FOOD_TYPES,
  lookupFoodType,
} from "../services/nutritionLookup.service";
// Feature ingredientes_frescos: search the nutritional_reference catalog.
import { searchNutritionalReference } from "../services/nutritionalData.service";

export const nutritionRouter = Router();

// GET /api/v1/nutrition/lookup?food_type={type}
// Returns base nutritional values per 100g for the requested food type category.
// Rate limit: 5 req/sec per user (enforced in app.ts).
nutritionRouter.get("/lookup", requireAuth, (req, res, next) => {
  try {
    const foodType = req.query.food_type;

    if (typeof foodType !== "string" || !foodType) {
      return next(
        new ApiError(
          400,
          "MISSING_FOOD_TYPE",
          "Query parameter food_type is required",
        ),
      );
    }

    const nutrition = lookupFoodType(foodType);
    if (!nutrition) {
      return next(
        new ApiError(
          404,
          "FOOD_TYPE_NOT_FOUND",
          `Food type '${foodType}' is not in the catalog`,
        ),
      );
    }

    return res.json({
      food_type: foodType,
      calories_per_100g: nutrition.calories_per_100g,
      protein_per_100g: nutrition.protein_per_100g,
      carbs_per_100g: nutrition.carbs_per_100g,
      fat_per_100g: nutrition.fat_per_100g,
    });
  } catch (err) {
    return next(err);
  }
});

// GET /api/v1/nutrition/categories
// Returns the list of valid food type categories for the dropdown.
nutritionRouter.get("/categories", requireAuth, (_req, res) => {
  return res.json({ categories: FOOD_TYPES });
});

// Feature ingredientes_frescos (AC-027-17):
// GET /api/v1/nutrition/reference?q={text}
// Search the nutritional_reference catalog by name/alias; per-100g macros.
nutritionRouter.get("/reference", requireAuth, async (req, res, next) => {
  try {
    const q = req.query.q;
    if (typeof q !== "string" || q.trim().length === 0) {
      return next(
        new ApiError(400, "MISSING_QUERY", "Query parameter q is required"),
      );
    }
    const results = await searchNutritionalReference(q);
    return res.json({ results });
  } catch (err) {
    return next(err);
  }
});

// ─── Confirm endpoint ─────────────────────────────────────────────────────────

const IngredientSchema = z.object({
  name: z.string().min(1).max(100),
  quantity_grams: z.number().int().min(1).max(9999),
  food_type: z.string().min(1),
  calories: z.number().nonnegative(),
  protein_g: z.number().nonnegative(),
  carbs_g: z.number().nonnegative(),
  fat_g: z.number().nonnegative(),
  source: z.enum(["ai", "manual", "manual_added"]),
});

const TotalsSchema = z.object({
  calories: z.number().nonnegative(),
  protein_g: z.number().nonnegative(),
  carbs_g: z.number().nonnegative(),
  fat_g: z.number().nonnegative(),
});

const ConfirmPayloadSchema = z.object({
  user_id: z.string().uuid(),
  timestamp: z.string().datetime(),
  session_id: z.string().uuid(),
  ingredients: z
    .array(IngredientSchema)
    .min(1, "At least one ingredient is required"),
  totals: TotalsSchema,
});

// POST /api/v1/ingredients/confirm
// Validates the ingredient editing payload before Feature 012 receives it.
// Enforces ownership: user_id in JWT must match user_id in body.
export const ingredientsRouter = Router();

ingredientsRouter.post("/confirm", requireAuth, (req, res, next) => {
  try {
    const userId = getRequiredUserId(req);

    const parsed = ConfirmPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return next(
        new ApiError(400, "INVALID_PAYLOAD", parsed.error.errors[0].message),
      );
    }

    const payload = parsed.data;

    // Invariant 2: Ownership enforcement — JWT user_id must match payload user_id.
    if (payload.user_id !== userId) {
      return next(
        new ApiError(
          403,
          "OWNERSHIP_VIOLATION",
          "user_id in payload does not match authenticated user",
        ),
      );
    }

    // Validate food types exist in catalog.
    for (const ingredient of payload.ingredients) {
      if (!lookupFoodType(ingredient.food_type)) {
        return next(
          new ApiError(
            400,
            "INVALID_FOOD_TYPE",
            `Food type '${ingredient.food_type}' is not in the catalog`,
          ),
        );
      }
    }

    // Validate non-negative values (contract invariant 4).
    for (const ingredient of payload.ingredients) {
      if (
        ingredient.calories < 0 ||
        ingredient.protein_g < 0 ||
        ingredient.carbs_g < 0 ||
        ingredient.fat_g < 0
      ) {
        return next(
          new ApiError(
            400,
            "NEGATIVE_NUTRITIONAL_VALUE",
            `Ingredient '${ingredient.name}' has negative nutritional values`,
          ),
        );
      }
    }

    return res.json({
      status: "confirmed",
      user_id: payload.user_id,
      timestamp: payload.timestamp,
      session_id: payload.session_id,
      ingredient_count: payload.ingredients.length,
    });
  } catch (err) {
    return next(err);
  }
});
