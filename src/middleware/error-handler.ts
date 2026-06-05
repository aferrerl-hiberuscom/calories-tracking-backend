import type { NextFunction, Request, Response } from "express";
import { ApiError } from "./api-error";

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  const apiError =
    err instanceof ApiError
      ? err
      : new ApiError(500, "INTERNAL_ERROR", "Unexpected error");

  return res.status(apiError.status).json({
    timestamp: new Date().toISOString(),
    status: apiError.status,
    code: apiError.code,
    message: apiError.message,
    path: req.originalUrl,
  });
}
