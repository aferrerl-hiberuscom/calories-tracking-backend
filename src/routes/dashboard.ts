import { Router } from "express";
import { z } from "zod";
import { getRequiredUserId, requireAuth } from "../middleware/auth";
import { prisma } from "../lib/prisma";
import { ApiError } from "../middleware/api-error";

export const dashboardRouter = Router();

const DashboardQuerySchema = z.object({
  period: z.enum(["daily", "weekly", "monthly"]).default("daily"),
  date: z.string().datetime().optional(),
});

function resolveRange(
  period: "daily" | "weekly" | "monthly",
  anchor: Date,
): { start: Date; end: Date } {
  const start = new Date(anchor);
  const end = new Date(anchor);

  if (period === "daily") {
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
    return { start, end };
  }

  if (period === "weekly") {
    const day = start.getUTCDay();
    const offsetToMonday = (day + 6) % 7;
    start.setUTCDate(start.getUTCDate() - offsetToMonday);
    start.setUTCHours(0, 0, 0, 0);
    end.setTime(start.getTime());
    end.setUTCDate(start.getUTCDate() + 6);
    end.setUTCHours(23, 59, 59, 999);
    return { start, end };
  }

  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  end.setUTCMonth(start.getUTCMonth() + 1, 0);
  end.setUTCHours(23, 59, 59, 999);
  return { start, end };
}

dashboardRouter.get("/", requireAuth, async (req, res, next) => {
  const parsed = DashboardQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return next(
      new ApiError(400, "VALIDATION_ERROR", "Invalid dashboard query"),
    );
  }

  const userId = getRequiredUserId(req);
  const anchorDate = parsed.data.date ? new Date(parsed.data.date) : new Date();
  const { start, end } = resolveRange(parsed.data.period, anchorDate);

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

    return res.json({
      period: parsed.data.period,
      calories_kcal: totals.calories_kcal,
      protein_g: totals.protein_g,
      carbs_g: totals.carbs_g,
      fat_g: totals.fat_g,
      meal_count: meals.length,
    });
  } catch (error) {
    return next(error);
  }
});
