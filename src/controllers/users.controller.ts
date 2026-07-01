/**
 * Feature 022 — user provisioning and profile.
 * Controller: POST /api/v1/users/me, GET /api/v1/users/me
 */

import type { NextFunction, Request, Response } from "express";
import { getRequiredUserEmail, getRequiredUserId } from "../middleware/auth";
import {
  ensureCurrentUser,
  getCurrentUser,
  type UserProfile,
} from "../services/users.service";

function toResponseBody(user: UserProfile) {
  return { id: user.id, email: user.email, created_at: user.createdAt };
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
