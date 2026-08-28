import { describe, it, expect } from "vitest";
import { parseManualUsage } from "../../src/adapters/manual.js";
describe("manual", () => {
  it("parses pasted text for kimi", () => {
    const q = parseManualUsage("kimi", `Current week: 22% used · resets Aug 29 at 11am`, new Date("2026-08-28T06:00:00+10:00"));
    expect(q.provider).toBe("kimi");
    expect(q.usedPct).toBe(22);
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
    expect(q.usedPct).toBe(16);
    const expected = now.getTime() + ((3 * 24 + 1) * 3600 + 24 * 60) * 1000;
    expect(new Date(q.resetsAt).getTime()).toBe(expected);
  });
});
