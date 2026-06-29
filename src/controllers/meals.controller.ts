/**
 * Feature 013 — Confirmación y guardado de comida
 * Controller: POST /api/v1/meals
 */

import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../middleware/api-error";
import { getRequiredUserId } from "../middleware/auth";
import { validateMealPayload } from "../services/meals/validateMealPayload";
import { saveMeal } from "../services/meals/meals.service";
import type { MealPayload } from "../services/meals/validateMealPayload";

/**
 * POST /api/v1/meals
 *
 * Flow:
 * 1. Extract userId from JWT (set by requireAuth middleware via req.userId)
 * 2. Validate payload with validateMealPayload
 * 3. Persist atomically with saveMeal
 * 4. Respond 201 { meal_id, status: "confirmed" }
 */
export async function createMeal(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = getRequiredUserId(req);

    const validation = validateMealPayload(req.body);
    if (!validation.valid) {
      next(
        new ApiError(
          400,
          "VALIDATION_ERROR",
          validation.errors.join("; ")
        )
      );
      return;
    }

    const idempotencyKey = req.headers["idempotency-key"];
    const key = typeof idempotencyKey === "string" && idempotencyKey.trim().length > 0
      ? idempotencyKey.trim()
      : undefined;

    const result = await saveMeal(userId, req.body as MealPayload, key);

    res.status(201).json({
      meal_id: result.mealId,
      status: "confirmed",
    });
  } catch (error) {
    next(error);
  }
}
