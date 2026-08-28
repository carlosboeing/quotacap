import { describe, it, expect } from "vitest";
import { parseManualUsage } from "../../src/adapters/manual.js";
describe("manual", () => {
  it("parses pasted text for kimi", () => {
    const q = parseManualUsage("kimi", `Current week: 22% used · resets Aug 29 at 11am`, new Date("2026-08-28T06:00:00+10:00"));
    expect(q.provider).toBe("kimi");
    expect(q.usedPct).toBe(22);
    expect(q.source).toBe("manual");
  });
});
