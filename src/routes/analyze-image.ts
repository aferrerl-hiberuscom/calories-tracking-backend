import { Router } from "express";
import { z } from "zod";
import { requireAuth, getRequiredUserId } from "../middleware/auth";
import { ApiError } from "../middleware/api-error";
import { analyzeImageWithFallback } from "../services/analyze-image.service";
import { fetchImageFromStorage } from "../services/storage.service";
import {
  extractStorageKey,
  verifyImageOwnership,
} from "../lib/image-ownership";

export const analyzeImageRouter = Router();

const SUPPORTED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB hard limit

/**
 * Canonical input schema for POST /api/v1/analyze-image.
 * Accepts image_url (Supabase Storage URL, uploaded by feature 003)
 * and user_id for ownership verification.
 */
const AnalyzeImageSchema = z.object({
  image_url: z.string().url({ message: "image_url must be a valid URL" }),
  user_id: z.string().uuid({ message: "user_id must be a valid UUID" }),
  meal_date: z.string().datetime().optional(),
});

analyzeImageRouter.post("/", requireAuth, async (req, res, next) => {
  // 1. Parse and validate request body
  const parsed = AnalyzeImageSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(
      new ApiError(
        400,
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "Invalid request payload",
      ),
    );
  }

  const { image_url, user_id, meal_date: mealDate } = parsed.data;

  // 2. Ensure user_id matches the authenticated user
  const authenticatedUserId = getRequiredUserId(req);
  if (user_id !== authenticatedUserId) {
    return next(
      new ApiError(
        403,
        "FORBIDDEN_OWNERSHIP",
        "user_id does not match authenticated user",
      ),
    );
  }

  // 3. Extract storage key from URL, verify image ownership
  let storageKey: string;
  try {
    storageKey = extractStorageKey(image_url);
  } catch (err) {
    return next(err);
  }

  try {
    await verifyImageOwnership(storageKey, authenticatedUserId);
  } catch (err) {
    return next(err);
  }

  // 4. Fetch image bytes from storage
  let imageBase64: string;
  let mimeType: SupportedMimeType;
  try {
    const fetched = await fetchImageFromStorage(storageKey);
    imageBase64 = fetched.base64;

    if (!SUPPORTED_MIME_TYPES.includes(fetched.mimeType as SupportedMimeType)) {
      return next(
        new ApiError(
          400,
          "INVALID_IMAGE_FORMAT",
          `Unsupported image format: ${fetched.mimeType}. Supported: JPG, PNG, WEBP`,
        ),
      );
    }
    mimeType = fetched.mimeType as SupportedMimeType;

    // Validate size from base64 estimate
    const clean = imageBase64.replace(/^data:[^;]+;base64,/, "");
    const padding = clean.match(/=+$/)?.[0].length ?? 0;
    const imageBytes = Math.floor((clean.length * 3) / 4) - padding;
    if (imageBytes > MAX_IMAGE_BYTES) {
      return next(
        new ApiError(400, "IMAGE_TOO_LARGE", "Image exceeds 10 MB limit"),
      );
    }
  } catch (err) {
    if (err instanceof ApiError) {
      return next(err);
    }
    return next(
      new ApiError(
        503,
        "STORAGE_UNAVAILABLE",
        "Could not fetch image from storage",
      ),
    );
  }

  // 5. Call AI service (handles providers, fallback, retry, metadata)
  try {
    const analyzed = await analyzeImageWithFallback({
      imageBase64,
      mimeType,
      mealDate,
      userId: authenticatedUserId,
    });

    return res.json({
      dish_description: analyzed.dish_description,
      ingredients: analyzed.ingredients,
      totals: analyzed.totals,
      metadata: analyzed.metadata,
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
