import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { ApiError } from "../middleware/api-error";
import * as authService from "../services/auth.service";

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Contract 001 v2.0.0: email unique, password >= 8 chars, optional name.
const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(120).optional(),
});

const RefreshSchema = z.object({
  refresh_token: z.string().min(1),
});

function toEnvelope(tokens: authService.AuthTokens) {
  return {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: "Bearer" as const,
    expires_in: tokens.expiresIn,
  };
}

export async function postLogin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(
      new ApiError(400, "VALIDATION_ERROR", "Invalid credentials payload"),
    );
  }
  try {
    const tokens = await authService.login(
      parsed.data.email,
      parsed.data.password,
    );
    return res.status(200).json(toEnvelope(tokens));
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/auth/register — contract 001 v2.0.0 (A-001 registration).
 * 201 with the same token envelope as login (auto-login).
 */
export async function postRegister(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(
      new ApiError(
        400,
        "VALIDATION_ERROR",
        "Invalid registration payload (email required; password >= 8 chars; name 1..120 optional)",
      ),
    );
  }
  try {
    const tokens = await authService.register(
      parsed.data.email,
      parsed.data.password,
      parsed.data.name,
    );
    return res.status(201).json(toEnvelope(tokens));
  } catch (err) {
    return next(err);
  }
}

export async function postRefresh(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const parsed = RefreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(
      new ApiError(400, "VALIDATION_ERROR", "Invalid refresh payload"),
    );
  }
  try {
    const tokens = await authService.refresh(parsed.data.refresh_token);
    return res.status(200).json(toEnvelope(tokens));
  } catch (err) {
    return next(err);
  }
}
