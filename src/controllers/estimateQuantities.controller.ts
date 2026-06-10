// Controller for feature 007 — Estimate Quantities
// Handles POST /api/v1/meals/:mealId/estimate-quantities
// Handles PUT  /api/v1/meals/:mealId/ingredients/:ingredientId/quantity

import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { ApiError } from "../middleware/api-error";
import { getRequiredUserId } from "../middleware/auth";
import { prisma } from "../lib/prisma";
import {
  estimateQuantities,
  updateIngredientQuantity,
} from "../services/estimateQuantities.service";

const IngredientInputSchema = z.object({
  name: z.string().min(1).max(120),
  confidence: z.number().min(0).max(1).optional(),
  source: z.string().optional(),
});

const EstimateRequestSchema = z.object({
  image_url: z.string().url().optional(),
  ingredients: z
    .array(IngredientInputSchema)
    .min(1, "ingredients cannot be empty"),
});

const UpdateQuantitySchema = z.object({
  quantity_g: z.number().min(1).max(5000),
});

export async function postEstimateQuantities(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = getRequiredUserId(req);
    const mealId = String(req.params.mealId);

    // Verify meal exists and belongs to user
    const meal = await prisma.meal.findUnique({ where: { id: mealId } });
    if (!meal) {
      return next(new ApiError(404, "MEAL_NOT_FOUND", "Meal not found"));
    }
    if (meal.userId !== userId) {
      return next(new ApiError(403, "FORBIDDEN", "Access denied"));
    }

    const parsed = EstimateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return next(
        new ApiError(
          400,
          "INVALID_PAYLOAD",
          parsed.error.errors[0]?.message ?? "Validation error",
        ),
      );
    }

    // Resolve image_url: prefer body value, fallback to meal's image
    let imageUrl = parsed.data.image_url;
    if (!imageUrl) {
      const image = await prisma.image.findUnique({ where: { mealId } });
      if (!image) {
        return next(
          new ApiError(
            400,
            "INVALID_PAYLOAD",
            "image_url is required when meal has no associated image",
          ),
        );
      }
      // Construct public URL from storage key (via storage service convention)
      const supabaseUrl = process.env.SUPABASE_URL ?? "";
      imageUrl = `${supabaseUrl}/storage/v1/object/public/${image.storageKey}`;
    }

    const result = await estimateQuantities(
      mealId,
      imageUrl as string,
      parsed.data.ingredients,
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function putIngredientQuantity(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = getRequiredUserId(req);
    const mealId = String(req.params.mealId);
    const ingredientId = String(req.params.ingredientId);

    // Verify meal ownership
    const meal = await prisma.meal.findUnique({ where: { id: mealId } });
    if (!meal) {
      return next(new ApiError(404, "MEAL_NOT_FOUND", "Meal not found"));
    }
    if (meal.userId !== userId) {
      return next(new ApiError(403, "FORBIDDEN", "Access denied"));
    }

    const parsed = UpdateQuantitySchema.safeParse(req.body);
    if (!parsed.success) {
      return next(
        new ApiError(
          400,
          "QUANTITY_OUT_OF_RANGE",
          "quantity_g must be between 1 and 5000",
        ),
      );
    }

    const result = await updateIngredientQuantity(
      ingredientId,
      mealId,
      parsed.data.quantity_g,
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
