import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { ApiError } from "../middleware/api-error";
import { analyzeImageWithFallback } from "../services/analyze-image.service";
import { fetchImageFromStorage } from "../services/storage.service";

export const analyzeImageRouter = Router();

/**
 * Schema for the base64 input path (existing / dev-stub flow).
 * imageBase64 must be a non-empty string.
 */
const Base64Schema = z.object({
  imageBase64: z.string().min(1),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  meal_date: z.string().datetime().optional(),
});

/**
 * Schema for the storage-key input path (post-feature-021 Supabase flow).
 * storage_key must be a non-empty string; mimeType is inferred from the key.
 */
const StorageKeySchema = z.object({
  storage_key: z.string().min(1),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
  meal_date: z.string().datetime().optional(),
});

/**
 * Accepts either `imageBase64` OR `storage_key` — at least one must be present.
 * Union is tried in order: base64 first (keeps backward compat), storage_key second.
 */
const AnalyzeImageSchema = z.union([Base64Schema, StorageKeySchema]);

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

  let imageBase64: string;
  let mimeType: "image/jpeg" | "image/png" | "image/webp";
  const mealDate = parsed.data.meal_date;

  if ("imageBase64" in parsed.data) {
    // Existing base64 path — validate size client-side estimate
    imageBase64 = parsed.data.imageBase64;
    mimeType = parsed.data.mimeType;

    const imageBytes = estimateBase64Bytes(imageBase64);
    if (imageBytes > MAX_IMAGE_BYTES) {
      return next(
        new ApiError(400, "VALIDATION_ERROR", "Image exceeds 10MB limit"),
      );
    }
  } else {
    // New storage_key path — fetch image from Supabase private storage
    try {
      const fetched = await fetchImageFromStorage(parsed.data.storage_key);
      imageBase64 = fetched.base64;
      mimeType =
        (parsed.data.mimeType as "image/jpeg" | "image/png" | "image/webp") ??
        (fetched.mimeType as "image/jpeg" | "image/png" | "image/webp");

      const imageBytes = estimateBase64Bytes(imageBase64);
      if (imageBytes > MAX_IMAGE_BYTES) {
        return next(
          new ApiError(400, "VALIDATION_ERROR", "Image exceeds 10MB limit"),
        );
      }
    } catch (err) {
      console.error("[analyze-image] storage fetch error:", err);
      return next(
        new ApiError(
          503,
          "STORAGE_UNAVAILABLE",
          "Could not fetch image from storage",
        ),
      );
    }
  }

  try {
    const analyzed = await analyzeImageWithFallback({
      imageBase64,
      mimeType,
      mealDate,
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
