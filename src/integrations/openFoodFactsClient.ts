// Feature 026 — Open Food Facts v2 client (contract §3.1, AC-026-05/06).
// Second level of the product-resolution cascade. Free API, no key; requires
// an identifying User-Agent. Conservative mapping: a product without ALL four
// essential macros per 100g is treated as a miss (null) so the user is routed
// to the label flow without ever seeing OFF's data gaps (D-BAR-05).

const DEFAULT_BASE_URL = "https://world.openfoodfacts.org";
const USER_AGENT = "CaloriesTracking/0.1 (dev; contact: project owner)";
const TIMEOUT_MS = 6_000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [1_000, 2_000] as const;

export type OffProduct = {
  name: string;
  brand?: string;
  caloriesKcal100g: number;
  proteinG100g: number;
  carbsG100g: number;
  fatG100g: number;
  servingSizeG?: number;
  servingLabel?: string;
};

function toFiniteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function mapPayload(payload: unknown): OffProduct | null {
  const root = (payload ?? {}) as Record<string, unknown>;
  // status: 1 = found, 0 = not found (OFF v2 contract)
  if (Number(root.status) !== 1) return null;

  const product = (root.product ?? {}) as Record<string, unknown>;
  const nutriments = (product.nutriments ?? {}) as Record<string, unknown>;

  const calories = toFiniteNumber(nutriments["energy-kcal_100g"]);
  const protein = toFiniteNumber(nutriments["proteins_100g"]);
  const carbs = toFiniteNumber(nutriments["carbohydrates_100g"]);
  const fat = toFiniteNumber(nutriments["fat_100g"]);

  const name = String(product.product_name ?? "").trim();

  // Essential macros incomplete (or unnamed) → conservative miss (AC-026-06).
  // Note: kJ is deliberately NOT converted — kcal must be explicit.
  if (
    !name ||
    calories === undefined ||
    protein === undefined ||
    carbs === undefined ||
    fat === undefined
  ) {
    return null;
  }

  const servingSizeG = toFiniteNumber(product.serving_quantity);
  const servingLabelRaw = String(product.serving_size ?? "").trim();

  return {
    name: name.slice(0, 120),
    brand: String(product.brands ?? "").trim().slice(0, 120) || undefined,
    caloriesKcal100g: calories,
    proteinG100g: protein,
    carbsG100g: carbs,
    fatG100g: fat,
    servingSizeG:
      servingSizeG !== undefined && servingSizeG >= 1 && servingSizeG <= 5000
        ? servingSizeG
        : undefined,
    servingLabel: servingLabelRaw ? servingLabelRaw.slice(0, 60) : undefined,
  };
}

/**
 * Resolve a normalized barcode against Open Food Facts.
 * Returns null on: not found, incomplete essential macros, or exhausted
 * transient failures — callers treat every null identically (D-BAR-05).
 */
export async function fetchProductFromOFF(
  barcode: string,
): Promise<OffProduct | null> {
  const baseUrl = (process.env.OFF_BASE_URL || DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const url = `${baseUrl}/api/v2/product/${barcode}.json`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const res = await fetchWithTimeout(url);

      // OFF returns 404 with a JSON body for unknown products — a miss.
      if (res.status === 404) return null;

      // Transient (429/5xx): retry with backoff, then give up as a miss.
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`OFF server error: ${res.status}`);
      }
      if (!res.ok) return null; // other 4xx — treat as miss, never surface raw

      return mapPayload(await res.json());
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_BACKOFF_MS[attempt] ?? 2_000),
        );
        continue;
      }
      console.log(
        JSON.stringify({
          level: "warn",
          service: "products",
          action: "off_unavailable",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return null;
    }
  }
  return null;
}
