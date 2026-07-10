// Feature 026 — product resolution and registration (contract §3.1/§3.3).
// Cascade: own Product table → Open Food Facts → persist hit. User-created
// products (label/manual) are global with traced origin and verified=false
// (D-BAR-07). Every OFF/DB gap resolves to a plain miss — the caller maps it
// to 404 PRODUCT_NOT_FOUND and the app routes to the label flow (D-BAR-05).

import type { Product, ProductSource } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { ApiError } from "../middleware/api-error";
import { fetchProductFromOFF } from "../integrations/openFoodFactsClient";

// API shape (contract §3.1) — snake_case; createdByUserId is never exposed.
export type ProductDto = {
  barcode: string;
  name: string;
  brand?: string;
  calories_kcal_100g: number;
  protein_g_100g: number;
  carbs_g_100g: number;
  fat_g_100g: number;
  serving_size_g?: number;
  serving_label?: string;
  source: ProductSource;
  verified: boolean;
};

export type CreateProductInput = {
  barcode: string; // already normalized by the route
  name: string;
  brand?: string;
  calories_kcal_100g: number;
  protein_g_100g: number;
  carbs_g_100g: number;
  fat_g_100g: number;
  serving_size_g?: number;
  serving_label?: string;
  source: "USER_LABEL" | "MANUAL";
};

export function toProductDto(product: Product): ProductDto {
  return {
    barcode: product.barcode,
    name: product.name,
    brand: product.brand ?? undefined,
    calories_kcal_100g: product.caloriesKcal100g,
    protein_g_100g: product.proteinG100g,
    carbs_g_100g: product.carbsG100g,
    fat_g_100g: product.fatG100g,
    serving_size_g: product.servingSizeG ?? undefined,
    serving_label: product.servingLabel ?? undefined,
    source: product.source,
    verified: product.verified,
  };
}

function logResolution(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ service: "products", ...fields }));
}

/**
 * BR-026-01 — energy coherence for user-provided macros: kcal must be within
 * ±30% of 4·protein + 4·carbs + 9·fat. Zero-everything (e.g. water) passes.
 */
export function macrosAreCoherent(input: {
  calories_kcal_100g: number;
  protein_g_100g: number;
  carbs_g_100g: number;
  fat_g_100g: number;
}): boolean {
  const estimated =
    4 * input.protein_g_100g + 4 * input.carbs_g_100g + 9 * input.fat_g_100g;
  if (estimated === 0) return input.calories_kcal_100g <= 5; // water-like foods
  return (
    Math.abs(input.calories_kcal_100g - estimated) / estimated <= 0.3
  );
}

/**
 * Resolution cascade (contract §3.1): own table → OFF → persist. Returns null
 * for every kind of miss (unknown barcode, incomplete OFF data, OFF outage).
 */
export async function resolveProduct(
  barcode: string,
): Promise<ProductDto | null> {
  const start = Date.now();

  const cached = await prisma.product.findUnique({ where: { barcode } });
  if (cached) {
    logResolution({
      level: "info",
      action: "resolved",
      resolution_source: "cache",
      latency_ms: Date.now() - start,
    });
    return toProductDto(cached);
  }

  const offProduct = await fetchProductFromOFF(barcode);
  if (!offProduct) {
    logResolution({
      level: "info",
      action: "miss",
      latency_ms: Date.now() - start,
    });
    return null;
  }

  try {
    const created = await prisma.product.create({
      data: {
        barcode,
        name: offProduct.name,
        brand: offProduct.brand,
        caloriesKcal100g: offProduct.caloriesKcal100g,
        proteinG100g: offProduct.proteinG100g,
        carbsG100g: offProduct.carbsG100g,
        fatG100g: offProduct.fatG100g,
        servingSizeG: offProduct.servingSizeG,
        servingLabel: offProduct.servingLabel,
        source: "OFF",
        verified: true, // only complete OFF data reaches this point (AC-026-05)
      },
    });
    logResolution({
      level: "info",
      action: "resolved",
      resolution_source: "off",
      latency_ms: Date.now() - start,
    });
    return toProductDto(created);
  } catch {
    // Unique-constraint race (two concurrent scans): the row now exists.
    const existing = await prisma.product.findUnique({ where: { barcode } });
    return existing ? toProductDto(existing) : null;
  }
}

/**
 * User registration of a product (label-confirmed or manual — contract §3.3).
 * Returns { conflict: true } with the existing product for the 409 path.
 */
export async function createProduct(
  input: CreateProductInput,
  userId: string,
): Promise<{ conflict: boolean; product: ProductDto }> {
  if (!macrosAreCoherent(input)) {
    throw new ApiError(
      422,
      "MACROS_INCOHERENT",
      "Las calorías no son coherentes con los macronutrientes indicados (kcal ≈ 4·proteínas + 4·carbohidratos + 9·grasas)",
    );
  }

  const existing = await prisma.product.findUnique({
    where: { barcode: input.barcode },
  });
  if (existing) {
    return { conflict: true, product: toProductDto(existing) };
  }

  try {
    const created = await prisma.product.create({
      data: {
        barcode: input.barcode,
        name: input.name.trim().slice(0, 120),
        brand: input.brand?.trim().slice(0, 120) || undefined,
        caloriesKcal100g: input.calories_kcal_100g,
        proteinG100g: input.protein_g_100g,
        carbsG100g: input.carbs_g_100g,
        fatG100g: input.fat_g_100g,
        servingSizeG: input.serving_size_g,
        servingLabel: input.serving_label?.trim().slice(0, 60) || undefined,
        source: input.source,
        verified: false, // user contributions are never born verified (D-BAR-07)
        createdByUserId: userId,
      },
    });
    logResolution({
      level: "info",
      action: "product_created",
      resolution_source: input.source === "MANUAL" ? "manual" : "label",
    });
    return { conflict: false, product: toProductDto(created) };
  } catch {
    // Unique-constraint race: surface as conflict with the winner row.
    const winner = await prisma.product.findUnique({
      where: { barcode: input.barcode },
    });
    if (winner) return { conflict: true, product: toProductDto(winner) };
    throw new ApiError(500, "INTERNAL_ERROR", "Could not register product");
  }
}
