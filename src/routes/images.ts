import { Router } from "express";
import { z } from "zod";
import { getRequiredUserId, requireAuth } from "../middleware/auth";
import { ApiError } from "../middleware/api-error";
import { prisma } from "../lib/prisma";
import {
  getSignedUploadUrl,
  getSignedViewUrl,
} from "../services/storage.service";

export const imagesRouter = Router();

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

const RequestUploadUrlSchema = z.object({
  mime_type: z.enum(ALLOWED_MIME_TYPES),
  size_bytes: z
    .number()
    .int()
    .positive()
    .max(MAX_SIZE_BYTES, "Image exceeds 5MB limit"),
});

/**
 * POST /api/v1/images/upload-url
 *
 * Issues a signed upload URL for the authenticated user so the mobile
 * client can upload directly to private storage (AC-003, AC-012).
 *
 * The client declares the MIME type and compressed size; the backend validates
 * both before issuing the URL. Magic-bytes validation runs on the client before
 * this call (AC-005).
 */
imagesRouter.post("/upload-url", requireAuth, async (req, res, next) => {
  const parsed = RequestUploadUrlSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(
      new ApiError(
        400,
        "VALIDATION_ERROR",
        parsed.error.errors[0]?.message ?? "Invalid payload",
      ),
    );
  }

  const userId = getRequiredUserId(req);

  try {
    const { storageKey, uploadUrl } = await getSignedUploadUrl(
      userId,
      parsed.data.mime_type,
    );

    return res.status(201).json({
      storage_key: storageKey,
      upload_url: uploadUrl,
      expires_in: 300,
    });
  } catch (err) {
    console.error("[images] upload-url error:", err);
    return next(
      new ApiError(503, "STORAGE_UNAVAILABLE", "Storage service unavailable"),
    );
  }
});

/**
 * GET /api/v1/images/:mealId/view-url
 *
 * Returns a signed view URL for the meal image, restricted to the meal owner
 * (AC-006, AC-012). Non-owner requests receive 403.
 */
imagesRouter.get("/:mealId/view-url", requireAuth, async (req, res, next) => {
  const userId = getRequiredUserId(req);
  const mealId =
    typeof req.params.mealId === "string" ? req.params.mealId : undefined;

  if (!mealId) {
    return next(new ApiError(400, "VALIDATION_ERROR", "Missing mealId"));
  }

  try {
    const meal = await prisma.meal.findUnique({
      where: { id: mealId },
      include: { image: true },
    });

    if (!meal) {
      return next(new ApiError(404, "NOT_FOUND", "Meal not found"));
    }

    // Enforce ownership — non-owner receives 403 (AC-006)
    if (meal.userId !== userId) {
      return next(
        new ApiError(
          403,
          "FORBIDDEN",
          "Image does not belong to authenticated user",
        ),
      );
    }

    if (!meal.image) {
      return next(
        new ApiError(404, "NOT_FOUND", "No image associated with this meal"),
      );
    }

    const viewUrl = await getSignedViewUrl(meal.image.storageKey);

    return res.json({
      view_url: viewUrl,
      expires_in: 3600,
    });
  } catch (err) {
    if (err instanceof ApiError) return next(err);
    console.error("[images] view-url error:", err);
    return next(
      new ApiError(503, "STORAGE_UNAVAILABLE", "Storage service unavailable"),
    );
  }
});
