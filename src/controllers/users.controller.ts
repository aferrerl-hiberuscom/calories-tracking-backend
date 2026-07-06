/**
 * Feature 022 — user provisioning and profile.
 * Controller: POST /api/v1/users/me, GET /api/v1/users/me
 */

import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { ApiError } from "../middleware/api-error";
import { getRequiredUserEmail, getRequiredUserId } from "../middleware/auth";
import {
  ensureCurrentUser,
  getCurrentUser,
  updateCurrentUser,
  type UserProfile,
} from "../services/users.service";
import {
  getGoals,
  upsertGoals,
} from "../services/nutrition-goals.service";

function toResponseBody(user: UserProfile) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    created_at: user.createdAt,
  };
}

/**
 * POST /api/v1/users/me — idempotent (BR-029). Identity is derived
 * exclusively from the authenticated token; the request has no body.
 */
export async function postMe(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = getRequiredUserId(req);
    const email = getRequiredUserEmail(req);
    const { user, created } = await ensureCurrentUser(userId, email);
    res.status(created ? 201 : 200).json(toResponseBody(user));
  } catch (error) {
    next(error);
  }
}

/** GET /api/v1/users/me — 404 if the identity has not been provisioned yet. */
export async function getMe(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = getRequiredUserId(req);
    const user = await getCurrentUser(userId);
    res.status(200).json(toResponseBody(user));
  } catch (error) {
    next(error);
  }
}

// ─── Evolution ui_redesign_brote ─────────────────────────────────────────────

const UpdateMeSchema = z.object({
  name: z.string().min(1).max(120),
});

/** PUT /api/v1/users/me — update the display name (022 v1.3 / 025 v1.0.0). */
export async function putMe(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const parsed = UpdateMeSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(
      new ApiError(400, "VALIDATION_ERROR", "name must be 1..120 characters"),
    );
  }
  try {
    const userId = getRequiredUserId(req);
    const user = await updateCurrentUser(userId, parsed.data);
    res.status(200).json(toResponseBody(user));
  } catch (error) {
    next(error);
  }
}

// Feature 025 — integer daily targets; kcal bounded, macros non-negative.
const GoalsSchema = z.object({
  calories_kcal_target: z.number().int().min(1000).max(6000),
  protein_g_target: z.number().int().min(0),
  carbs_g_target: z.number().int().min(0),
  fat_g_target: z.number().int().min(0),
});

/** GET /api/v1/users/me/goals — ALWAYS 200; defaults + is_default until first edit. */
export async function getMyGoals(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = getRequiredUserId(req);
    res.status(200).json(await getGoals(userId));
  } catch (error) {
    next(error);
  }
}

/** PUT /api/v1/users/me/goals — upsert (first edit creates the row). */
export async function putMyGoals(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const parsed = GoalsSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(
      new ApiError(
        400,
        "VALIDATION_ERROR",
        "Goals must be integers; calories_kcal_target 1000..6000, macros >= 0",
      ),
    );
  }
  try {
    const userId = getRequiredUserId(req);
    res.status(200).json(await upsertGoals(userId, parsed.data));
  } catch (error) {
    next(error);
  }
}
