/**
 * Evolution ui_redesign_brote — meal-type inference (contract 013 v2.x,
 * A-013-02; clarify D-BROTE-01).
 *
 * The type is inferred from the LOCAL hour of the meal as written by the
 * client in the `meal_date` ISO-8601 string (the clock time before the
 * timezone offset), NOT from the server's timezone. Bands:
 *   BREAKFAST 05:00–11:59 · LUNCH 12:00–16:59 · DINNER 17:00–23:59 ·
 *   SNACK 00:00–04:59
 */

import type { MealType } from "@prisma/client";

export function mealTypeForHour(hour: number): MealType {
  if (hour >= 5 && hour <= 11) return "BREAKFAST";
  if (hour >= 12 && hour <= 16) return "LUNCH";
  if (hour >= 17 && hour <= 23) return "DINNER";
  return "SNACK";
}

/**
 * Extracts the local clock hour from an ISO-8601 timestamp string
 * ("2026-07-03T14:30:00+02:00" -> 14) so the client's stated wall-clock time
 * governs the inference. Falls back to the parsed Date's UTC hour when the
 * string has no explicit time component.
 */
export function inferMealTypeFromIso(isoDate: string): MealType {
  const match = /T(\d{2})/.exec(isoDate);
  if (match) {
    const hour = Number(match[1]);
    if (hour >= 0 && hour <= 23) {
      return mealTypeForHour(hour);
    }
  }
  return mealTypeForHour(new Date(isoDate).getUTCHours());
}
