import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { ApiError } from "./api-error";

type JwtPayload = {
  sub: string;
  // Optional: older/test tokens may carry only `sub`.
  email?: string;
};

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return next(new ApiError(401, "UNAUTHORIZED", "Missing bearer token"));
  }

  const token = authHeader.slice("Bearer ".length);
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return next(
      new ApiError(500, "CONFIG_ERROR", "JWT secret is not configured"),
    );
  }

  try {
    const decoded = jwt.verify(token, secret) as JwtPayload;
    req.userId = decoded.sub;
    req.userEmail = decoded.email;
    return next();
  } catch {
    return next(new ApiError(401, "UNAUTHORIZED", "Invalid token"));
  }
}

export function getRequiredUserId(req: Request): string {
  if (!req.userId) {
    throw new ApiError(
      401,
      "UNAUTHORIZED",
      "Missing authenticated user context",
    );
  }
  return req.userId;
}

export function getRequiredUserEmail(req: Request): string {
  if (!req.userEmail) {
    throw new ApiError(
      401,
      "UNAUTHORIZED",
      "Missing authenticated user context",
    );
  }
  return req.userEmail;
}
