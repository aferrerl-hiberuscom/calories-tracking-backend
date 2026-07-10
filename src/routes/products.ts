// Feature 026 — product endpoints (contract §3).
// GET /:barcode           → resolution cascade (cache → OFF → persist)
// POST /label-extraction  → nutrition-label reading via Gemini (never persists)
// POST /                  → user registration of a product (label/manual)

import { Router } from "express";
import { z } from "zod";
import { requireAuth, getRequiredUserId } from "../middleware/auth";
import { ApiError } from "../middleware/api-error";
import { rateLimit } from "../middleware/rate-limit";
import { normalizeBarcode } from "../lib/barcode";
import { extractNutritionLabel } from "../integrations/geminiLabelClient";
import { PermanentProviderError } from "../integrations/providerErrors";
import { createProduct, resolveProduct } from "../services/products.service";

export const productsRouter = Router();
productsRouter.use(requireAuth);

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // same hard limit as analyze-image

const LabelExtractionSchema = z.object({
  image_base64: z.string().min(1),
  mime_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
});

const CreateProductSchema = z.object({
  barcode: z.string().min(8).max(14),
  name: z.string().min(1).max(120),
  brand: z.string().max(120).optional(),
  calories_kcal_100g: z.number().min(0).max(900),
  protein_g_100g: z.number().min(0).max(100),
  carbs_g_100g: z.number().min(0).max(100),
  fat_g_100g: z.number().min(0).max(100),
  serving_size_g: z.number().min(1).max(5000).optional(),
  serving_label: z.string().max(60).optional(),
  source: z.enum(["USER_LABEL", "MANUAL"]),
});

// Label extraction is an AI-analysis endpoint: stricter bucket (contract §5).
const labelExtractionRateLimit = rateLimit({ max: 10, windowMs: 60_000 });

productsRouter.get("/:barcode", async (req, res, next) => {
  const normalized = normalizeBarcode(String(req.params.barcode ?? ""));
  if (!normalized) {
    return next(
      new ApiError(
        400,
        "INVALID_BARCODE",
        "barcode must be EAN-13, EAN-8 or UPC-A (digits only)",
      ),
    );
  }

  try {
    const product = await resolveProduct(normalized);
    if (!product) {
      // Unknown barcode, incomplete OFF data and OFF outages are deliberately
      // indistinguishable (D-BAR-05): the client routes to the label flow.
      return next(
        new ApiError(404, "PRODUCT_NOT_FOUND", "Product not found"),
      );
    }
    return res.json(product);
  } catch (err) {
    return next(err);
  }
});

productsRouter.post(
  "/label-extraction",
  labelExtractionRateLimit,
  async (req, res, next) => {
    const parsed = LabelExtractionSchema.safeParse(req.body);
    if (!parsed.success) {
      return next(
        new ApiError(
          400,
          "VALIDATION_ERROR",
          parsed.error.issues[0]?.message ?? "Invalid payload",
        ),
      );
    }

    const clean = parsed.data.image_base64.replace(/^data:[^;]+;base64,/, "");
    const padding = clean.match(/=+$/)?.[0].length ?? 0;
    const imageBytes = Math.floor((clean.length * 3) / 4) - padding;
    if (imageBytes > MAX_IMAGE_BYTES) {
      return next(
        new ApiError(400, "IMAGE_TOO_LARGE", "Image exceeds 10 MB limit"),
      );
    }

    try {
      const extraction = await extractNutritionLabel({
        imageBase64: clean,
        mimeType: parsed.data.mime_type,
      });

      if (!extraction.isLabel) {
        return next(
          new ApiError(
            422,
            "NOT_NUTRITION_LABEL",
            "La imagen no contiene una tabla nutricional legible",
          ),
        );
      }

      return res.json({
        calories_kcal_100g: extraction.caloriesKcal100g,
        protein_g_100g: extraction.proteinG100g,
        carbs_g_100g: extraction.carbsG100g,
        fat_g_100g: extraction.fatG100g,
        serving_size_g: extraction.servingSizeG ?? null,
        confidence: extraction.confidence,
      });
    } catch (err) {
      if (err instanceof ApiError) return next(err);
      if (err instanceof PermanentProviderError) {
        return next(
          new ApiError(400, "IA_INVALID_REQUEST", "AI provider rejected the image"),
        );
      }
      // Transient/exhausted — client offers retry or manual entry (D-BAR-08).
      return next(
        new ApiError(
          503,
          "IA_UNAVAILABLE",
          "El servicio de lectura de etiquetas no está disponible ahora mismo",
        ),
      );
    }
  },
);

productsRouter.post("/", async (req, res, next) => {
  const parsed = CreateProductSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(
      new ApiError(
        400,
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "Invalid payload",
      ),
    );
  }

  const normalized = normalizeBarcode(parsed.data.barcode);
  if (!normalized) {
    return next(
      new ApiError(
        400,
        "INVALID_BARCODE",
        "barcode must be EAN-13, EAN-8 or UPC-A (digits only)",
      ),
    );
  }

  try {
    const result = await createProduct(
      { ...parsed.data, barcode: normalized },
      getRequiredUserId(req),
    );

    if (result.conflict) {
      // 409 carries the existing product so the client uses it directly.
      return res.status(409).json({
        code: "PRODUCT_ALREADY_EXISTS",
        message: "Este producto ya está registrado",
        product: result.product,
      });
    }
    return res.status(201).json(result.product);
  } catch (err) {
    return next(err);
  }
});
