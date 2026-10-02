import { describe, it, expect } from "vitest";
import { parseManualUsage } from "../../src/adapters/manual.js";
describe("manual", () => {
  it("parses pasted text for kimi", () => {
    const q = parseManualUsage("kimi", `Current week: 22% used · resets Aug 29 at 11am`, new Date("2026-08-28T06:00:00+10:00"));
    expect(q.provider).toBe("kimi");
    expect(q.weeklyPct).toBe(22);
    expect(q.source).toBe("manual");
  });

  it("parses the reset date from the text instead of guessing +3d", () => {
    const now = new Date("2026-08-28T06:00:00+10:00");
    const q = parseManualUsage("kimi", `Current week: 22% used · resets Aug 29 at 11am`, now);
    expect(q.resetsAt).toMatch(/^2026-08-29/);
  });

  it("parses kimi's real dashboard format (relative duration, weekly window)", () => {
    const now = new Date("2026-08-28T22:00:00Z");
    const text = [
      "Usage",
      "Session usage: No active session.",
      "Weekly limit  ███░░░░░░░░░░░░░░░░░  16% used  resets in 3d 1h 24m",
      "5h limit      ░░░░░░░░░░░░░░░░░░░░  0% used   resets in 3h 24m",
    ].join("\n");
    const q = parseManualUsage("kimi", text, now);
    expect(q.weeklyPct).toBe(16);
    expect(q.fiveHourPct).toBe(0);
    const expected = now.getTime() + ((3 * 24 + 1) * 3600 + 24 * 60) * 1000;
    expect(new Date(q.resetsAt).getTime()).toBe(expected);
  });

  it("prefers the weekly reset when it is nearer than the 5h reset", () => {
    const now = new Date("2026-08-28T22:00:00Z");
    const text = [
      "Weekly limit  92% used  resets in 1h 30m",
      "5h limit      19% used  resets in 3h 29m",
    ].join("\n");
    const q = parseManualUsage("claude", text, now);
    const expected = now.getTime() + (1 * 3600 + 30 * 60) * 1000;
    expect(new Date(q.resetsAt).getTime()).toBe(expected);
  });
});
