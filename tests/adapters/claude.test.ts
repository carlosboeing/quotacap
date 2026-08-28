import { describe, it, expect } from "vitest";
import { parseClaudeUsage } from "../../src/adapters/claude.js";

const sample = `You are currently using your subscription

Current session: 46% used · resets Aug 28 at 4:30pm (Australia/Brisbane)
Current week (all models): 25% used · resets Sep 3 at 9pm (Australia/Brisbane)
`;

describe("parseClaudeUsage", () => {
  it("parses 46% session and 25% weekly with Brisbane tz", () => {
    const q = parseClaudeUsage(sample, new Date("2026-08-28T06:00:00+10:00"));
    expect(q.usedPct).toBe(25);
    expect(q.sessionPct).toBe(46);
    expect(q.provider).toBe("claude");
    expect(q.resetsAt).toMatch(/2026-09-03/);
  });
});
