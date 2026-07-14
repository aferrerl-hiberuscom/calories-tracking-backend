import { Router } from "express";
import { z } from "zod";
import { getRequiredUserId, requireAuth } from "../middleware/auth";
import { ApiError } from "../middleware/api-error";
import { prisma } from "../lib/prisma";
import { deleteImage } from "../services/storage.service";
import { rateLimit } from "../middleware/rate-limit";
import {
  postEstimateQuantities,
  putIngredientQuantity,
} from "../controllers/estimateQuantities.controller";
import { calculateCalories } from "../services/calculateCalories.service";
// Feature 013: confirm and save meal
import { createMeal } from "../controllers/meals.controller";
// Feature favoritos_mis_platos: mark/unmark a meal as favorite (contract 028 §3.3/3.4)
import { favoriteMeal, unfavoriteMeal } from "../services/dishes.service";

export const mealsRouter = Router();

const ListMealsQuerySchema = z.object({
  start_date: z.string().datetime().optional(),
  end_date: z.string().datetime().optional(),
  // Feature 014: offset pagination for meal history. Opt-in via `limit`.
  // When `limit` is absent, the legacy date-range behaviour is preserved.
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// Feature 014: shared mapping for a meal list item (history cards need image + macros).
// Evolution ui_redesign_brote (014 v2.0.0, A-014-01): expose name + meal_type.
function mapMealListItem(meal: {
  id: string;
  name: string;
  mealType: import("@prisma/client").MealType;
  mealDate: Date;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  nutrition: {
    caloriesKcal: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
    totalWeightG: number;
  } | null;
  image?: { storageKey: string } | null;
  // Feature favoritos_mis_platos: present (non-null) when the meal is favorited.
  favoriteDish?: { id: string } | null;
}) {
  return {
    meal_id: meal.id,
    name: meal.name,
    meal_type: meal.mealType,
    meal_date: meal.mealDate.toISOString(),
    status: meal.status,
    calories_kcal: meal.nutrition?.caloriesKcal ?? 0,
    protein_g: meal.nutrition?.proteinG ?? 0,
    carbs_g: meal.nutrition?.carbsG ?? 0,
    fat_g: meal.nutrition?.fatG ?? 0,
    total_weight_g: meal.nutrition?.totalWeightG ?? 0,
    image: meal.image ? { storage_key: meal.image.storageKey } : null,
    // is_favorite = a Dish with sourceMealId = this meal exists (D-FAV-06).
    is_favorite: meal.favoriteDish != null,
    created_at: meal.createdAt.toISOString(),
    updated_at: meal.updatedAt.toISOString(),
  };
}

function resolveParamId(value: string | string[] | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  throw new ApiError(400, "VALIDATION_ERROR", "Missing meal id");
}

mealsRouter.get("/", requireAuth, async (req, res, next) => {
  const parsed = ListMealsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return next(
      new ApiError(400, "VALIDATION_ERROR", "Invalid query parameters"),
    );
  }

  const userId = getRequiredUserId(req);
  const { start_date, end_date, limit, offset } = parsed.data;
  const paginationMode = limit !== undefined;

  // Build the meal-date filter:
  //  - explicit start/end always apply (range query)
  //  - otherwise, only the legacy today-default applies (non-pagination mode)
  //  - in pagination mode without dates → no date filter (full history)
  let mealDateFilter: { gte?: Date; lte?: Date } | undefined;
  if (start_date || end_date) {
    mealDateFilter = {};
    if (start_date) mealDateFilter.gte = new Date(start_date);
    if (end_date) mealDateFilter.lte = new Date(end_date);
  } else if (!paginationMode) {
    const now = new Date();
    mealDateFilter = {
      gte: new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
      ),
      lte: new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          23,
          59,
          59,
          999,
        ),
      ),
    };
  }

  const where = {
    userId,
    status: "confirmed",
    ...(mealDateFilter ? { mealDate: mealDateFilter } : {}),
  };

  try {
    if (paginationMode) {
      const skip = offset ?? 0;
      const [meals, total] = await Promise.all([
        prisma.meal.findMany({
          where,
          include: {
            nutrition: true,
            image: true,
            favoriteDish: { select: { id: true } },
          },
          orderBy: { mealDate: "desc" },
          take: limit,
          skip,
        }),
        prisma.meal.count({ where }),
      ]);

      return res.json({
        meals: meals.map(mapMealListItem),
        count: meals.length,
        total,
        limit,
        offset: skip,
      });
    }

    const meals = await prisma.meal.findMany({
      where,
      include: {
        nutrition: true,
        image: true,
        favoriteDish: { select: { id: true } },
      },
      orderBy: { mealDate: "desc" },
    });

    return res.json({
      meals: meals.map(mapMealListItem),
      count: meals.length,
    });
  } catch (error) {
    return next(error);
  }
});

mealsRouter.get("/:id", requireAuth, async (req, res, next) => {
  const userId = getRequiredUserId(req);
  const mealId = resolveParamId(req.params.id);

  try {
    const meal = await prisma.meal.findUnique({
      where: { id: mealId },
      include: {
        ingredients: true,
        nutrition: true,
        image: true,
        favoriteDish: { select: { id: true } },
      },
    });

    if (!meal) {
      return next(new ApiError(404, "NOT_FOUND", "Meal not found"));
    }
    if (meal.userId !== userId) {
      return next(
        new ApiError(
          403,
          "FORBIDDEN",
          "Meal does not belong to authenticated user",
        ),
      );
    }

    return res.json({
      meal_id: meal.id,
      // Evolution ui_redesign_brote (014 v2.0.0, A-014-02): detail DTO.
      name: meal.name,
      meal_type: meal.mealType,
      meal_date: meal.mealDate.toISOString(),
      status: meal.status,
      ingredients: meal.ingredients.map((ing) => ({
        id: ing.id,
        name: ing.name,
        quantity_g: ing.quantityG,
        source: ing.source,
        cooking_method: ing.cookingMethod ?? null,
        confidence: ing.confidence ?? null,
      })),
      nutrition: meal.nutrition
        ? {
            calories_kcal: meal.nutrition.caloriesKcal,
            protein_g: meal.nutrition.proteinG,
            carbs_g: meal.nutrition.carbsG,
            fat_g: meal.nutrition.fatG,
            total_weight_g: meal.nutrition.totalWeightG,
          }
        : null,
      image: meal.image
        ? {
            storage_key: meal.image.storageKey,
            mime_type: meal.image.mimeType,
            size_bytes: meal.image.sizeBytes,
          }
        : null,
      // Feature favoritos_mis_platos (D-FAV-06): is_favorite in the detail DTO.
      is_favorite: meal.favoriteDish != null,
      created_at: meal.createdAt.toISOString(),
      updated_at: meal.updatedAt.toISOString(),
    });
  } catch (error) {
    return next(error);
  }
});

// ─── Feature favoritos_mis_platos: mark/unmark favorite (contract 028 §3.3/3.4) ─
// Ergonomic per-meal toggle; the Dish lifecycle lives in dishes.service.

mealsRouter.post("/:id/favorite", requireAuth, async (req, res, next) => {
  const userId = getRequiredUserId(req);
  const mealId = resolveParamId(req.params.id);
  try {
    const result = await favoriteMeal(userId, mealId);
    if (!result) {
      return next(new ApiError(404, "MEAL_NOT_FOUND", "Meal not found"));
    }
    // 201 when a favorite was created, 200 when it already existed (idempotent).
    return res.status(result.created ? 201 : 200).json(result.dish);
  } catch (error) {
    return next(error);
  }
});

mealsRouter.delete("/:id/favorite", requireAuth, async (req, res, next) => {
  const userId = getRequiredUserId(req);
  const mealId = resolveParamId(req.params.id);
  try {
    const ok = await unfavoriteMeal(userId, mealId);
    if (ok === null) {
      return next(new ApiError(404, "MEAL_NOT_FOUND", "Meal not found"));
    }
    return res.status(204).send();
  } catch (error) {
    return next(error);
  }
});

// ─── Feature 013: POST /api/v1/meals — Confirm and save meal ──────────────────
// Canonical endpoint. Validates payload and persists atomically.
// Rate limit (60 req/min) is already applied at app.ts for /api/v1/meals.
// requestLogger (app-wide) already records user_id, endpoint, status, latency.
mealsRouter.post("/", requireAuth, createMeal);

const UpdateMealPayloadSchema = z.object({
  ingredients: z
    .array(
      z.object({
        name: z.string().min(1),
        quantity_g: z.number().positive(),
        source: z.enum(["visible", "inferred", "manual"]),
        confidence: z.number().min(0).max(1).optional(),
        cooking_method: z.string().optional(),
        calories_kcal: z.number().nonnegative().optional(),
        protein_g: z.number().nonnegative().optional(),
        carbs_g: z.number().nonnegative().optional(),
        fat_g: z.number().nonnegative().optional(),
      }),
    )
    .min(1),
  nutrition: z.object({
    calories_kcal: z.number().nonnegative(),
    protein_g: z.number().nonnegative(),
    carbs_g: z.number().nonnegative(),
    fat_g: z.number().nonnegative(),
    total_weight_g: z.number().nonnegative(),
  }),
  // Feature 014 (BR-017): the meal date is an editable field.
  meal_date: z.string().datetime().optional(),
  // Evolution ui_redesign_brote (014 v2.0.0, A-014-03): dish name and meal
  // type are editable in B3.
  name: z.string().min(1).max(120).optional(),
  meal_type: z.enum(["BREAKFAST", "LUNCH", "DINNER", "SNACK"]).optional(),
});

mealsRouter.put("/:id", requireAuth, async (req, res, next) => {
  // Feature 014 (BR-018 / contract Cond. 5): the image is NOT editable.
  // Reject any attempt to change it instead of silently ignoring it.
  if (
    req.body &&
    typeof req.body === "object" &&
    ("image" in req.body || "image_url" in req.body)
  ) {
    return next(
      new ApiError(
        400,
        "VALIDATION_ERROR",
        "Image cannot be changed; create a new meal to use a different image",
      ),
    );
  }

  const parsed = UpdateMealPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(
      new ApiError(400, "VALIDATION_ERROR", "Invalid meal update payload"),
    );
  }

  const userId = getRequiredUserId(req);
  const mealId = resolveParamId(req.params.id);

  try {
    const meal = await prisma.meal.findUnique({ where: { id: mealId } });
    if (!meal) {
      return next(new ApiError(404, "NOT_FOUND", "Meal not found"));
    }
    if (meal.userId !== userId) {
      return next(
        new ApiError(
          403,
          "FORBIDDEN",
          "Meal does not belong to authenticated user",
        ),
      );
    }

    await prisma.$transaction(async (tx) => {
      // Feature 014 (BR-017): persist edited meal date when provided.
      // Evolution ui_redesign_brote (A-014-03): also name and meal type.
      const mealUpdates: {
        mealDate?: Date;
        name?: string;
        mealType?: import("@prisma/client").MealType;
      } = {};
      if (parsed.data.meal_date !== undefined) {
        mealUpdates.mealDate = new Date(parsed.data.meal_date);
      }
      if (parsed.data.name !== undefined) {
        mealUpdates.name = parsed.data.name;
      }
      if (parsed.data.meal_type !== undefined) {
        mealUpdates.mealType = parsed.data.meal_type;
      }
      if (Object.keys(mealUpdates).length > 0) {
        await tx.meal.update({
          where: { id: meal.id },
          data: mealUpdates,
        });
      }

      await tx.ingredient.deleteMany({ where: { mealId: meal.id } });
      await tx.ingredient.createMany({
        data: parsed.data.ingredients.map((ingredient) => ({
          mealId: meal.id,
          name: ingredient.name,
          quantityG: ingredient.quantity_g,
          source:
            ingredient.source.toUpperCase() as import("@prisma/client").IngredientSource,
          confidence: ingredient.confidence,
          cookingMethod: ingredient.cooking_method,
          // Feature 009: persist per-ingredient macros; source=MANUAL when user edited
          caloriesKcal: ingredient.calories_kcal ?? 0,
          proteinG: ingredient.protein_g ?? 0,
          carbsG: ingredient.carbs_g ?? 0,
          fatG: ingredient.fat_g ?? 0,
        })),
      });

      await tx.nutritionalData.upsert({
        where: { mealId: meal.id },
        create: {
          mealId: meal.id,
          caloriesKcal: parsed.data.nutrition.calories_kcal,
          proteinG: parsed.data.nutrition.protein_g,
          carbsG: parsed.data.nutrition.carbs_g,
          fatG: parsed.data.nutrition.fat_g,
          totalWeightG: parsed.data.nutrition.total_weight_g,
        },
        update: {
          caloriesKcal: parsed.data.nutrition.calories_kcal,
          proteinG: parsed.data.nutrition.protein_g,
          carbsG: parsed.data.nutrition.carbs_g,
          fatG: parsed.data.nutrition.fat_g,
          totalWeightG: parsed.data.nutrition.total_weight_g,
        },
      });
    });

    return res.json({ meal_id: meal.id, status: "updated" });
  } catch (error) {
    return next(error);
  }
});

mealsRouter.delete("/:id", requireAuth, async (req, res, next) => {
  const userId = getRequiredUserId(req);
  const mealId = resolveParamId(req.params.id);

  try {
    const meal = await prisma.meal.findUnique({ where: { id: mealId } });
    if (!meal) {
      return next(new ApiError(404, "NOT_FOUND", "Meal not found"));
    }
    if (meal.userId !== userId) {
      return next(
        new ApiError(
          403,
          "FORBIDDEN",
          "Meal does not belong to authenticated user",
        ),
      );
    }

    // Fetch image key before deletion so we can clean up storage (AC-007)
    const mealWithImage = await prisma.meal.findUnique({
      where: { id: meal.id },
      include: { image: true },
    });
    const imageKey = mealWithImage?.image?.storageKey;

    await prisma.meal.delete({ where: { id: meal.id } });

    // Delete from storage after DB delete; errors are logged but do not
    // block the response (AC-007: deletion failures logged without blocking)
    if (imageKey) {
      void deleteImage(imageKey);
    }

    return res.json({ meal_id: meal.id, status: "deleted" });
  } catch (error) {
    return next(error);
  }
});

// ─── Feature 007: Estimate Quantities ─────────────────────────────────────────

mealsRouter.post(
  "/:mealId/estimate-quantities",
  requireAuth,
  rateLimit({ max: 10, windowMs: 60_000 }),
  postEstimateQuantities,
);

mealsRouter.put(
  "/:mealId/ingredients/:ingredientId/quantity",
  requireAuth,
  putIngredientQuantity,
);

// ─── Feature 008: Calculate Calories ──────────────────────────────────────────

const CalculateNutritionRequestSchema = z.object({
  ingredients: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        quantity_g: z.number().nonnegative(),
        confidence: z.number().min(0).max(1),
        source: z.string().min(1),
        calories_kcal: z.number().nonnegative().optional(),
        protein_g: z.number().nonnegative().optional(),
        carbs_g: z.number().nonnegative().optional(),
        fat_g: z.number().nonnegative().optional(),
      }),
    )
    .min(1),
});

mealsRouter.post(
  "/:mealId/calculate-nutrition",
  requireAuth,
  rateLimit({ max: 10, windowMs: 60_000 }),
  async (req, res, next) => {
    const userId = getRequiredUserId(req);
    const mealId = resolveParamId(req.params.mealId);

    const parsed = CalculateNutritionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return next(
        new ApiError(
          400,
          "VALIDATION_ERROR",
          "Invalid calculate-nutrition payload",
        ),
      );
    }

    try {
      // Ownership check — contract invariant 5
      const meal = await prisma.meal.findUnique({ where: { id: mealId } });
      if (!meal) {
        return next(new ApiError(404, "NOT_FOUND", "Meal not found"));
      }
      if (meal.userId !== userId) {
        return next(
          new ApiError(
            403,
            "FORBIDDEN",
            "Meal does not belong to authenticated user",
          ),
        );
      }

      const result = await calculateCalories(mealId, parsed.data.ingredients);

      // Persist calculated nutritional values to DB (contract invariant 6: audit trail)
      await prisma.$transaction(async (tx) => {
        // Update per-ingredient nutritional values
        for (const ing of result.ingredients) {
          await tx.ingredient.updateMany({
            where: {
              mealId,
              name: ing.name,
            },
            data: {
              caloriesKcal: ing.calories_kcal,
              proteinG: ing.protein_g,
              carbsG: ing.carbs_g,
              fatG: ing.fat_g,
              nutritionSuspicious: ing.nutrition_suspicious,
              allergen: ing.allergen,
              allergenList: ing.allergen_list,
              dietaryType: ing.dietary_type ?? null,
              discrepancyDetected: ing.discrepancy_detected,
              aiCaloriesKcal: ing.ai_calories_kcal ?? null,
              dbCaloriesKcal: ing.db_calories_kcal ?? null,
            },
          });
        }

        // Upsert meal-level nutritional totals
        await tx.nutritionalData.upsert({
          where: { mealId },
          create: {
            mealId,
            caloriesKcal: result.totals.total_calories_kcal,
            proteinG: result.totals.total_protein_g,
            carbsG: result.totals.total_carbs_g,
            fatG: result.totals.total_fat_g,
            totalWeightG: result.totals.total_weight_g,
          },
          update: {
            caloriesKcal: result.totals.total_calories_kcal,
            proteinG: result.totals.total_protein_g,
            carbsG: result.totals.total_carbs_g,
            fatG: result.totals.total_fat_g,
            totalWeightG: result.totals.total_weight_g,
          },
        });
      });

      return res.json(result);
    } catch (error) {
      return next(error);
    }
  },
);
