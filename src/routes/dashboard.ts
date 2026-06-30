import { Router } from "express";
import { z } from "zod";
import { getRequiredUserId, requireAuth } from "../middleware/auth";
import { prisma } from "../lib/prisma";
import { ApiError } from "../middleware/api-error";
import { isValidTimeZone, zonedRange } from "../lib/zoned-range";
import { computeMacroDistribution } from "../lib/macro-distribution";

export const dashboardRouter = Router();

const DashboardQuerySchema = z.object({
  period: z.enum(["daily", "weekly", "monthly"]).default("daily"),
  date: z.string().datetime().optional(),
  // Feature 015 (AC-009): IANA timezone in which the period is evaluated.
  tz: z.string().min(1).optional(),
});

dashboardRouter.get("/", requireAuth, async (req, res, next) => {
  const parsed = DashboardQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return next(
      new ApiError(400, "VALIDATION_ERROR", "Invalid dashboard query"),
    );
  }

  const tz = parsed.data.tz ?? "UTC";
  if (!isValidTimeZone(tz)) {
    return next(new ApiError(400, "VALIDATION_ERROR", "Invalid timezone"));
  }

  const userId = getRequiredUserId(req);
  const anchorDate = parsed.data.date ? new Date(parsed.data.date) : new Date();
  const { start, end } = zonedRange(parsed.data.period, tz, anchorDate);

  try {
    const meals = await prisma.meal.findMany({
      where: {
        userId,
        status: "confirmed",
        mealDate: {
          gte: start,
          lte: end,
        },
      },
      include: {
        nutrition: true,
      },
      orderBy: {
        mealDate: "desc",
      },
    });

    const totals = meals.reduce(
      (acc, meal) => {
        acc.calories_kcal += meal.nutrition?.caloriesKcal ?? 0;
        acc.protein_g += meal.nutrition?.proteinG ?? 0;
        acc.carbs_g += meal.nutrition?.carbsG ?? 0;
        acc.fat_g += meal.nutrition?.fatG ?? 0;
        return acc;
      },
      { calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
    );

    // Feature 016: relative proportion of protein/carbs/fat for the period.
    const macro_distribution = computeMacroDistribution(
      totals.protein_g,
      totals.carbs_g,
      totals.fat_g,
    );

    return res.json({
      period: parsed.data.period,
      calories_kcal: totals.calories_kcal,
      protein_g: totals.protein_g,
      carbs_g: totals.carbs_g,
      fat_g: totals.fat_g,
      macro_distribution,
      meal_count: meals.length,
    });
  } catch (error) {
    return next(error);
  }
});
