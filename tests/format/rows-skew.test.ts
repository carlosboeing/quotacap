import { describe, it, expect } from "vitest";
import { weeklyPctOf } from "../../src/format/rows.js";

describe("CLI reads the weekly percent from a daemon of either version", () => {
  it("prefers weeklyPct and falls back to the 0.0.39 usedPct", () => {
    expect(weeklyPctOf({ weeklyPct: 12, usedPct: 12 })).toBe(12);
    expect(weeklyPctOf({ usedPct: 30 })).toBe(30);
    expect(weeklyPctOf(null)).toBeUndefined();
  });
});
