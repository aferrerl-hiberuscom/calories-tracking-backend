/**
 * Feature 015 — Timezone-aware period ranges for the daily calorie dashboard.
 *
 * Period boundaries (daily / weekly = Mon–Sun / monthly = 1st–last day) are
 * evaluated in the user's IANA timezone (contract AC-009 / Invariant 10) and
 * returned as UTC instants for querying `mealDate` (stored in UTC).
 *
 * Native `Intl` only — the backend has no date library and the guidelines
 * discourage adding one.
 *
 * ponytail: single-pass offset resolution. The local→UTC conversion reads the
 * zone offset at the *guessed* instant, which can be off by up to 1h only for a
 * wall-clock time that lands inside a DST transition. Period edges are local
 * midnight, where EU/US transitions never occur, so this is correct for the
 * dashboard. Upgrade path if ever needed: two-pass refine (recompute the offset
 * at the candidate instant and adjust).
 */

export type DashboardPeriod = "daily" | "weekly" | "monthly";

/** True if `tz` is an IANA zone the runtime understands. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const DOW: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Wall-clock parts of `instant` as seen in `tz`. */
function wallPartsInZone(instant: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(instant);

  const m: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") m[p.type] = p.value;
  }
  let h = Number(m.hour);
  if (h === 24) h = 0; // some ICU builds emit "24" at local midnight
  return {
    y: Number(m.year),
    mo: Number(m.month),
    d: Number(m.day),
    h,
    mi: Number(m.minute),
    s: Number(m.second),
    dow: DOW[m.weekday],
  };
}

/** Offset of `tz` from UTC at `instant`, in ms (positive = ahead of UTC). */
function tzOffsetMs(instant: Date, tz: string): number {
  const w = wallPartsInZone(instant, tz);
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  // formatToParts has second granularity; align the instant before differencing
  // so the offset stays a clean whole-minute value.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** UTC instant for a wall-clock time expressed in `tz`. */
function localToUtc(
  y: number, mo: number, d: number,
  h: number, mi: number, s: number, ms: number,
  tz: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const offset = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - offset);
}

/**
 * Period range in `tz`, as UTC instants. The wall-clock date of `anchorUtc` in
 * `tz` selects which day/week/month is summarized.
 */
export function zonedRange(
  period: DashboardPeriod,
  tz: string,
  anchorUtc: Date,
): { start: Date; end: Date } {
  const { y, mo, d, dow } = wallPartsInZone(anchorUtc, tz);

  if (period === "weekly") {
    const offsetToMonday = (dow + 6) % 7; // Mon→0, Sun→6
    const monday = new Date(Date.UTC(y, mo - 1, d - offsetToMonday));
    const sunday = new Date(Date.UTC(y, mo - 1, d - offsetToMonday + 6));
    return {
      start: localToUtc(
        monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate(),
        0, 0, 0, 0, tz,
      ),
      end: localToUtc(
        sunday.getUTCFullYear(), sunday.getUTCMonth() + 1, sunday.getUTCDate(),
        23, 59, 59, 999, tz,
      ),
    };
  }

  if (period === "monthly") {
    const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate(); // day 0 of next month
    return {
      start: localToUtc(y, mo, 1, 0, 0, 0, 0, tz),
      end: localToUtc(y, mo, lastDay, 23, 59, 59, 999, tz),
    };
  }

  // daily
  return {
    start: localToUtc(y, mo, d, 0, 0, 0, 0, tz),
    end: localToUtc(y, mo, d, 23, 59, 59, 999, tz),
  };
}
