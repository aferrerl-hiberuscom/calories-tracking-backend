// Feature 027 — dish endpoints (contract §3).
// POST /              → create per-user reusable dish (201)
// POST /suggest-name  → best-effort AI name inference (always 200 for valid
//                       payloads; dish_name null when the provider is down)
// Feature 028 — personal catalog (contract 028 §3).
// GET /               → list own dishes, newest first (200, empty list ok)
// DELETE /:id         → delete own dish (204; 404 DISH_NOT_FOUND otherwise)

import { Router } from "express";
import { z } from "zod";
import { requireAuth, getRequiredUserId } from "../middleware/auth";
import { ApiError } from "../middleware/api-error";
import { rateLimit } from "../middleware/rate-limit";
import { normalizeBarcode } from "../lib/barcode";
import {
  createDish,
  deleteDish,
  listDishes,
  suggestName,
} from "../services/dishes.service";

export const dishesRouter = Router();
dishesRouter.use(requireAuth);

const SuggestNameSchema = z.object({
  ingredient_names: z.array(z.string().min(1).max(120)).min(2).max(30),
});

const DishIngredientSchema = z.object({
  name: z.string().min(1).max(120),
  product_barcode: z.string().min(8).max(14).optional(),
  quantity_g: z.number().min(1).max(5000),
  calories_kcal: z.number().min(0),
  protein_g: z.number().min(0),
  carbs_g: z.number().min(0),
  fat_g: z.number().min(0),
});

const CreateDishSchema = z.object({
  name: z.string().min(1).max(120),
  ingredients: z.array(DishIngredientSchema).min(1).max(30),
});

// AI bucket (contract §3.1): same limit class as other analysis endpoints.
const suggestNameRateLimit = rateLimit({ max: 10, windowMs: 60_000 });

dishesRouter.post("/suggest-name", suggestNameRateLimit, async (req, res, next) => {
  const parsed = SuggestNameSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(
      new ApiError(
        400,
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "Invalid payload",
      ),
    );
  }

  // Best-effort by contract (BR-027-03): provider failures resolve to null
  // inside the service — this endpoint never 5xxes because of the AI.
  const suggestion = await suggestName(parsed.data.ingredient_names);
  return res.json(suggestion);
});

dishesRouter.get("/", async (req, res, next) => {
  try {
    const dishes = await listDishes(getRequiredUserId(req));
    return res.json({ dishes });
  } catch (err) {
    return next(err);
  }
});

// A non-uuid :id simply matches nothing in the compound delete and falls
// through to the same 404 — no separate validation needed (contract §3.2).
dishesRouter.delete("/:id", async (req, res, next) => {
  try {
    const deleted = await deleteDish(getRequiredUserId(req), req.params.id);
    if (!deleted) {
      return next(new ApiError(404, "DISH_NOT_FOUND", "Dish not found"));
    }
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
});

dishesRouter.post("/", async (req, res, next) => {
  const parsed = CreateDishSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(
      new ApiError(
        400,
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "Invalid payload",
      ),
    );
  }

  // Normalize optional product references; invalid ones are dropped (they are
  // informative only — the snapshot macros are the source of truth).
  const ingredients = parsed.data.ingredients.map((ing) => ({
    ...ing,
    product_barcode: ing.product_barcode
      ? (normalizeBarcode(ing.product_barcode) ?? undefined)
      : undefined,
  }));

  try {
    const dish = await createDish(getRequiredUserId(req), {
      name: parsed.data.name,
      ingredients,
    });
    return res.status(201).json(dish);
  } catch (err) {
    return next(err);
  }
});
