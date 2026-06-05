import type { NextFunction, Request, Response } from "express";
import Redis from "ioredis";
import {
  RateLimiterMemory,
  RateLimiterRedis,
  type RateLimiterRes,
} from "rate-limiter-flexible";
import { ApiError } from "./api-error";

type GenericLimiter = {
  consume: (key: string) => Promise<RateLimiterRes>;
};

const redisUrl = process.env.REDIS_URL?.trim();
const redisClient = redisUrl ? new Redis(redisUrl) : null;

const redisLimiters = new Map<string, RateLimiterRedis>();
const memoryLimiters = new Map<string, RateLimiterMemory>();

function resolveRequesterKey(req: Request): string {
  const userId = req.userId;
  if (userId) {
    return `user:${userId}`;
  }
  return `ip:${req.ip || "unknown"}`;
}

function resolveLimiter(max: number, windowMs: number): GenericLimiter {
  const duration = Math.ceil(windowMs / 1000);
  const limiterKey = `${max}:${duration}`;

  if (redisClient) {
    const existing = redisLimiters.get(limiterKey);
    if (existing) {
      return existing;
    }

    const limiter = new RateLimiterRedis({
      storeClient: redisClient,
      points: max,
      duration,
      keyPrefix: "rate-limit",
    });

    redisLimiters.set(limiterKey, limiter);
    return limiter;
  }

  const existing = memoryLimiters.get(limiterKey);
  if (existing) {
    return existing;
  }

  const limiter = new RateLimiterMemory({
    points: max,
    duration,
    keyPrefix: "rate-limit",
  });

  memoryLimiters.set(limiterKey, limiter);
  return limiter;
}

export function rateLimit(options: {
  max: number | ((req: Request) => number);
  windowMs: number;
  keyResolver?: (req: Request) => string;
}) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const max =
      typeof options.max === "function" ? options.max(req) : options.max;
    const key = `${req.path}:${options.keyResolver ? options.keyResolver(req) : resolveRequesterKey(req)}`;
    const limiter = resolveLimiter(max, options.windowMs);

    try {
      await limiter.consume(key);
      return next();
    } catch (error) {
      if (error instanceof Error) {
        return next(error);
      }
      return next(
        new ApiError(429, "RATE_LIMIT_EXCEEDED", "Too many requests"),
      );
    }
  };
}
