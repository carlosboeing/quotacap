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

  it("fallback resetsAt/periodStart/fetchedAt are deterministic from now", () => {
    const now = new Date("2026-08-20T00:00:00+10:00");
    const q = parseClaudeUsage("no weekly match", now);
    expect(q.resetsAt).toBe(new Date(now.getTime() + 7 * 86400000).toISOString());
    expect(q.periodStart).toBe(new Date(now.getTime() - 7 * 86400000).toISOString());
    expect(q.fetchedAt).toBe(now.toISOString());
  });
});

describe("pollAll isolation", () => {
  it("unknown provider resolves to rejected status without rejecting batch", async () => {
    const { pollAll } = await import("../../src/adapters/index.js");
    const res = await pollAll(["unknown-provider-xyz"]);
    expect(res).toHaveLength(1);
    expect(res[0].provider).toBe("unknown-provider-xyz");
    expect(res[0].status).toBe("rejected");
    expect((res[0] as { reason: Error }).reason).toBeInstanceOf(Error);
  });

  it("batch of unknowns all reject but Promise.all fulfills", async () => {
    const { pollAll } = await import("../../src/adapters/index.js");
    const res = await pollAll(["unknown1", "unknown2"]);
    expect(res).toHaveLength(2);
    expect(res[0].status).toBe("rejected");
    expect(res[1].status).toBe("rejected");
    expect(res[0].provider).toBe("unknown1");
    expect(res[1].provider).toBe("unknown2");
  });
});
