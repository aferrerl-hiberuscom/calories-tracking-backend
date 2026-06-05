import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { ApiError } from "../middleware/api-error";
import { analyzeImageWithFallback } from "../services/analyze-image.service";

export const analyzeImageRouter = Router();

const AnalyzeImageSchema = z.object({
  imageBase64: z.string().min(1),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  meal_date: z.string().datetime().optional(),
});

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function estimateBase64Bytes(base64: string): number {
  const clean = base64.replace(/^data:[^;]+;base64,/, "");
  const padding = clean.match(/=+$/)?.[0].length ?? 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

analyzeImageRouter.post("/", requireAuth, async (req, res, next) => {
  const parsed = AnalyzeImageSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(
      new ApiError(400, "VALIDATION_ERROR", "Invalid request payload"),
    );
  }

  const imageBytes = estimateBase64Bytes(parsed.data.imageBase64);
  if (imageBytes > MAX_IMAGE_BYTES) {
    return next(
      new ApiError(400, "VALIDATION_ERROR", "Image exceeds 10MB limit"),
    );
  }

  try {
    const analyzed = await analyzeImageWithFallback({
      imageBase64: parsed.data.imageBase64,
      mimeType: parsed.data.mimeType,
      mealDate: parsed.data.meal_date,
    });

    return res.json({
      description: analyzed.description,
      ingredients: analyzed.ingredients,
      total_weight_g: analyzed.total_weight_g,
      calories_kcal: analyzed.calories_kcal,
      protein_g: analyzed.protein_g,
      carbs_g: analyzed.carbs_g,
      fat_g: analyzed.fat_g,
      draft: {
        ingredients: analyzed.ingredients,
        nutrition: {
          calories_kcal: analyzed.calories_kcal,
          protein_g: analyzed.protein_g,
          carbs_g: analyzed.carbs_g,
          fat_g: analyzed.fat_g,
          total_weight_g: analyzed.total_weight_g,
        },
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return next(error);
    }
    return next(
      new ApiError(502, "AI_PROVIDER_ERROR", "AI provider call failed"),
    );
  }
});
