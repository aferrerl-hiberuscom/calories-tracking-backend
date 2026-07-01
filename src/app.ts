import cors from "cors";
import express from "express";
import helmet from "helmet";
import { analyzeImageRouter } from "./routes/analyze-image";
import { authRouter } from "./routes/auth";
import { dashboardRouter } from "./routes/dashboard";
import { healthRouter } from "./routes/health";
import { imagesRouter } from "./routes/images";
import { mealsRouter } from "./routes/meals";
import { nutritionRouter, ingredientsRouter } from "./routes/nutrition";
import { errorHandler } from "./middleware/error-handler";
import { rateLimit } from "./middleware/rate-limit";
import { requestLogger } from "./middleware/request-logger";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(requestLogger);

  app.use("/api/v1/health", healthRouter);
  // Feature 001: authentication (sign-in + refresh). Brute-force protection is
  // keyed by IP because requests are unauthenticated at this point.
  app.use(
    "/api/v1/auth",
    rateLimit({
      max: 10,
      windowMs: 60_000,
      keyResolver: (req) => `ip:${req.ip ?? "unknown"}`,
    }),
    authRouter,
  );
  app.use(
    "/api/v1/analyze-image",
    rateLimit({
      max: (req) => (req.userId ? 10 : 20),
      windowMs: 60_000,
      keyResolver: (req) =>
        req.userId ? `user:${req.userId}` : `ip:${req.ip}`,
    }),
    analyzeImageRouter,
  );
  app.use(
    "/api/v1/meals",
    rateLimit({ max: 60, windowMs: 60_000 }),
    mealsRouter,
  );
  app.use(
    "/api/v1/images",
    rateLimit({ max: 60, windowMs: 60_000 }),
    imagesRouter,
  );
  app.use(
    "/api/v1/dashboard",
    rateLimit({ max: 60, windowMs: 60_000 }),
    dashboardRouter,
  );
  // Feature 011: nutrition lookup (5 req/sec = 300 req/min per user, per contract §Non-Functional)
  app.use(
    "/api/v1/nutrition",
    rateLimit({ max: 5, windowMs: 1_000 }),
    nutritionRouter,
  );
  // Feature 011: ingredient confirm (standard rate limit)
  app.use(
    "/api/v1/ingredients",
    rateLimit({ max: 60, windowMs: 60_000 }),
    ingredientsRouter,
  );

  app.use(errorHandler);

  return app;
}
