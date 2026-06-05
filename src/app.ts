import cors from "cors";
import express from "express";
import helmet from "helmet";
import { analyzeImageRouter } from "./routes/analyze-image";
import { dashboardRouter } from "./routes/dashboard";
import { healthRouter } from "./routes/health";
import { imagesRouter } from "./routes/images";
import { mealsRouter } from "./routes/meals";
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

  app.use(errorHandler);

  return app;
}
