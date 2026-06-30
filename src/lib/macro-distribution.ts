/**
 * Feature 016 — Macronutrient distribution (read-only dashboard).
 *
 * Pure helper that derives the relative proportion of protein, carbohydrate,
 * and fat within the period's aggregated macronutrient grams. Returns integer
 * percentages that sum to exactly 100 when there is any macronutrient mass;
 * an empty/zero period yields all zeros (empty state — never an error).
 *
 * Kept free of any framework/runtime dependency so the dashboard route stays a
 * thin reducer over Prisma results.
 */

export type MacroDistribution = {
  protein_pct: number;
  carbs_pct: number;
  fat_pct: number;
};

export function computeMacroDistribution(
  proteinG: number,
  carbsG: number,
  fatG: number,
): MacroDistribution {
  const protein = Math.max(0, proteinG);
  const carbs = Math.max(0, carbsG);
  const fat = Math.max(0, fatG);
  const total = protein + carbs + fat;

  if (total <= 0) {
    return { protein_pct: 0, carbs_pct: 0, fat_pct: 0 };
  }

  const parts = [
    { key: "protein_pct" as const, exact: (protein / total) * 100 },
    { key: "carbs_pct" as const, exact: (carbs / total) * 100 },
    { key: "fat_pct" as const, exact: (fat / total) * 100 },
  ].map((p) => ({
    ...p,
    floor: Math.floor(p.exact),
    rem: p.exact - Math.floor(p.exact),
  }));

  const result: MacroDistribution = {
    protein_pct: 0,
    carbs_pct: 0,
    fat_pct: 0,
  };
  for (const p of parts) result[p.key] = p.floor;

  // Distribute the leftover units to the largest fractional remainders so the
  // integer percentages sum to exactly 100 (largest-remainder method).
  let remaining = 100 - parts.reduce((sum, p) => sum + p.floor, 0);
  const byRemainder = [...parts].sort((a, b) => b.rem - a.rem);
  for (
    let i = 0;
    i < byRemainder.length && remaining > 0;
    i += 1, remaining -= 1
  ) {
    result[byRemainder[i].key] += 1;
  }

  return result;
}
