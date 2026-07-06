/**
 * Evolution ui_redesign_brote — meal-type inference (contract 013 v2.x,
 * A-013-02). Band edges are the critical cases: 04:59/05:00, 11:59/12:00,
 * 16:59/17:00, 23:59/00:00.
 */

import { describe, expect, it } from "vitest";
import { inferMealTypeFromIso, mealTypeForHour } from "../../../lib/meal-type";

describe("mealTypeForHour — band edges", () => {
  it.each([
    [0, "SNACK"],
    [4, "SNACK"],
    [5, "BREAKFAST"],
    [11, "BREAKFAST"],
    [12, "LUNCH"],
    [16, "LUNCH"],
    [17, "DINNER"],
    [23, "DINNER"],
  ] as const)("hour %i -> %s", (hour, expected) => {
    expect(mealTypeForHour(hour)).toBe(expected);
  });
});

describe("inferMealTypeFromIso — local clock hour governs", () => {
  it("uses the clock hour written in the ISO string, not the server timezone", () => {
    // 14:30 local (with +02:00 offset) is LUNCH even though it is 12:30 UTC.
    expect(inferMealTypeFromIso("2026-07-03T14:30:00+02:00")).toBe("LUNCH");
  });

  it("infers BREAKFAST at 08:30 (contract example)", () => {
    expect(inferMealTypeFromIso("2026-07-03T08:30:00.000Z")).toBe("BREAKFAST");
  });

  it("infers DINNER at 21:15 (contract example)", () => {
    expect(inferMealTypeFromIso("2026-07-03T21:15:00.000Z")).toBe("DINNER");
  });

  it("infers SNACK in the 00:00–04:59 band", () => {
    expect(inferMealTypeFromIso("2026-07-03T04:59:00.000Z")).toBe("SNACK");
  });

  it("boundary 05:00 is BREAKFAST, 23:59 is DINNER", () => {
    expect(inferMealTypeFromIso("2026-07-03T05:00:00.000Z")).toBe("BREAKFAST");
    expect(inferMealTypeFromIso("2026-07-03T23:59:00.000Z")).toBe("DINNER");
  });
});
