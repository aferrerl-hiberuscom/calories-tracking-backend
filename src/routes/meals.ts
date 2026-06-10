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

export const mealsRouter = Router();

const MealPayloadSchema = z.object({
  meal_date: z.string().datetime(),
  ingredients: z
    .array(
      z.object({
        name: z.string().min(1),
        quantity_g: z.number().positive(),
        source: z.enum(["visible", "inferred", "manual"]),
        confidence: z.number().min(0).max(1).optional(),
        cooking_method: z.string().optional(),
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
  image: z.object({
    storage_key: z.string().min(1),
    mime_type: z.string().min(1),
    size_bytes: z.number().int().positive(),
  }),
});

const ListMealsQuerySchema = z.object({
  start_date: z.string().datetime().optional(),
  end_date: z.string().datetime().optional(),
});

const idempotencyMealMap = new Map<string, string>();

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
  const now = new Date();
  const startDate = parsed.data.start_date
    ? new Date(parsed.data.start_date)
    : new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          0,
          0,
          0,
          0,
        ),
      );
  const endDate = parsed.data.end_date
    ? new Date(parsed.data.end_date)
    : new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          23,
          59,
          59,
          999,
        ),
      );

  try {
    const meals = await prisma.meal.findMany({
      where: {
        userId,
        status: "confirmed",
        mealDate: { gte: startDate, lte: endDate },
      },
      include: { nutrition: true },
      orderBy: { mealDate: "desc" },
    });

    return res.json({
      meals: meals.map((meal) => ({
        meal_id: meal.id,
        meal_date: meal.mealDate.toISOString(),
        status: meal.status,
        calories_kcal: meal.nutrition?.caloriesKcal ?? 0,
        protein_g: meal.nutrition?.proteinG ?? 0,
        carbs_g: meal.nutrition?.carbsG ?? 0,
        fat_g: meal.nutrition?.fatG ?? 0,
        total_weight_g: meal.nutrition?.totalWeightG ?? 0,
        created_at: meal.createdAt.toISOString(),
        updated_at: meal.updatedAt.toISOString(),
      })),
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
      include: { ingredients: true, nutrition: true, image: true },
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
      created_at: meal.createdAt.toISOString(),
      updated_at: meal.updatedAt.toISOString(),
    });
  } catch (error) {
    return next(error);
  }
});

mealsRouter.post("/", requireAuth, async (req, res, next) => {
  const parsed = MealPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, "VALIDATION_ERROR", "Invalid meal payload"));
  }

  const userId = getRequiredUserId(req);
  const idempotencyKey = req.header("idempotency-key")?.trim();
  if (idempotencyKey) {
    const existing = idempotencyMealMap.get(`${userId}:${idempotencyKey}`);
    if (existing) {
      return res.status(201).json({ meal_id: existing, status: "created" });
    }
  }

  try {
    const createdMeal = await prisma.$transaction(async (tx) => {
      const meal = await tx.meal.create({
        data: {
          userId,
          mealDate: new Date(parsed.data.meal_date),
          status: "confirmed",
        },
      });

      await tx.ingredient.createMany({
        data: parsed.data.ingredients.map((ingredient) => ({
          mealId: meal.id,
          name: ingredient.name,
          quantityG: ingredient.quantity_g,
          source:
            ingredient.source.toUpperCase() as import("@prisma/client").IngredientSource,
          confidence: ingredient.confidence,
          cookingMethod: ingredient.cooking_method,
        })),
      });

      await tx.nutritionalData.create({
        data: {
          mealId: meal.id,
          caloriesKcal: parsed.data.nutrition.calories_kcal,
          proteinG: parsed.data.nutrition.protein_g,
          carbsG: parsed.data.nutrition.carbs_g,
          fatG: parsed.data.nutrition.fat_g,
          totalWeightG: parsed.data.nutrition.total_weight_g,
        },
      });

      await tx.image.create({
        data: {
          mealId: meal.id,
          storageKey: parsed.data.image.storage_key,
          mimeType: parsed.data.image.mime_type,
          sizeBytes: parsed.data.image.size_bytes,
        },
      });

      return meal;
    });

    if (idempotencyKey) {
      idempotencyMealMap.set(`${userId}:${idempotencyKey}`, createdMeal.id);
    }

    return res.status(201).json({ meal_id: createdMeal.id, status: "created" });
  } catch (error) {
    return next(error);
  }
});

const UpdateMealPayloadSchema = MealPayloadSchema.pick({
  ingredients: true,
  nutrition: true,
});

mealsRouter.put("/:id", requireAuth, async (req, res, next) => {
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
