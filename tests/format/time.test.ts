import { describe, expect, it } from "vitest";
import { clockText, dayText, durationFromDays, durationText, unusedAtReset } from "../../src/format/time.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-24T14:46:00+10:00"); // Sat

describe("durationText", () => {
  it("floors into one form at every scale", () => {
    expect(durationText(6 * DAY + 23.9 * HOUR)).toBe("6d 23h");
    expect(durationText(44 * HOUR)).toBe("1d 20h");
    expect(durationText(5 * HOUR + 12.9 * 60_000)).toBe("5h 12m");
    expect(durationText(45 * 60_000)).toBe("45m");
    expect(durationText(10_000)).toBe("1m");
    expect(durationText(0)).toBe("0m");
    expect(durationText(Number.NaN)).toBe("0m");
  });
  it("reads fractional days the same way, never rounding up a day", () => {
    expect(durationFromDays(5.99)).toBe("5d 23h");
    expect(durationFromDays(2.4)).toBe("2d 9h");
  });
});

describe("clockText", () => {
  it("drops the date within a week and keeps it beyond", () => {
    expect(clockText("2026-10-26T10:00:00+10:00", NOW)).toBe("Mon 10:00");
    expect(clockText("2026-11-22T23:05:00+10:00", NOW)).toBe("Sun 22 Nov 23:05");
    expect(clockText("2026-11-22T23:05:00+10:00")).toBe("Sun 22 Nov 23:05");
  });
  it("prints midnight as 00, never 24", () => {
    expect(clockText("2026-10-26T00:05:00+10:00", NOW)).toBe("Mon 00:05");
  });
  it("returns null for an unusable instant", () => {
    expect(clockText("not-a-date", NOW)).toBeNull();
    expect(clockText(null, NOW)).toBeNull();
  });
});

describe("dayText and unusedAtReset", () => {
  it("words the date and the waste sentence once", () => {
    expect(dayText("2026-11-22T23:05:00+10:00")).toBe("Sun 22 Nov");
    expect(unusedAtReset(15.6, "2026-10-30T13:14:00+10:00", NOW)).toBe("16% unused at reset (Fri 13:14)");
    expect(unusedAtReset(15.6, null)).toBe("16% unused at reset");
  });
});
