import { describe, expect, it } from "vitest";
import { isValidTimeZone, zonedRange } from "../../src/lib/zoned-range";

// 2026-06-15 is a Monday; Madrid is on CEST (UTC+2) in June (no DST edge here).
const anchor = new Date("2026-06-15T10:00:00.000Z");

describe("zonedRange", () => {
  it("daily range uses the zone's local-midnight boundaries (AC-009)", () => {
    const { start, end } = zonedRange("daily", "Europe/Madrid", anchor);
    expect(start.toISOString()).toBe("2026-06-14T22:00:00.000Z");
    expect(end.toISOString()).toBe("2026-06-15T21:59:59.999Z");
  });

  it("daily range in UTC matches the calendar day", () => {
    const { start, end } = zonedRange("daily", "UTC", anchor);
    expect(start.toISOString()).toBe("2026-06-15T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-06-15T23:59:59.999Z");
  });

  it("daily range west of UTC (America/New_York, EDT -4)", () => {
    const { start, end } = zonedRange("daily", "America/New_York", anchor);
    expect(start.toISOString()).toBe("2026-06-15T04:00:00.000Z");
    expect(end.toISOString()).toBe("2026-06-16T03:59:59.999Z");
  });

  it("weekly range is Monday–Sunday in the zone", () => {
    const { start, end } = zonedRange("weekly", "Europe/Madrid", anchor);
    expect(start.toISOString()).toBe("2026-06-14T22:00:00.000Z"); // Mon 15 00:00 CEST
    expect(end.toISOString()).toBe("2026-06-21T21:59:59.999Z"); // Sun 21 23:59:59.999 CEST
  });

  it("monthly range is 1st–last day of the zone's month", () => {
    const { start, end } = zonedRange("monthly", "Europe/Madrid", anchor);
    expect(start.toISOString()).toBe("2026-05-31T22:00:00.000Z"); // Jun 1 00:00 CEST
    expect(end.toISOString()).toBe("2026-06-30T21:59:59.999Z"); // Jun 30 23:59:59.999 CEST
  });

  it("validates IANA zones", () => {
    expect(isValidTimeZone("Europe/Madrid")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Phobos")).toBe(false);
  });
});
