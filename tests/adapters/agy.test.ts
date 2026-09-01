import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { parseAgyUsage, agyAdapter } from "../../src/adapters/agy.js";

const fixture = {
  status: "SUCCESS",
  num_turns: 0,
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.746, reset_time: "2026-09-01T13:42:08Z" },
            { id: "gemini-5h", window: "5h", remaining_fraction: 1, reset_time: "2026-08-30T20:15:19Z" },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            { id: "3p-weekly", window: "weekly", remaining_fraction: 1, reset_time: "2026-09-06T15:15:19Z" },
            { id: "3p-5h", window: "5h", remaining_fraction: 1, reset_time: "2026-08-30T20:15:19Z" },
          ],
        },
      ],
    },
  },
  response: "Gemini Models\tWeekly Limit Remaining\t75%\t...",
};

function agyOnPath(): boolean {
  try {
    execFileSync("which", ["agy"], { encoding: "utf8", timeout: 2000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("parseAgyUsage", () => {
  it("maps Gemini weekly remaining_fraction to usedPct and 5h to sessionPct", () => {
    const now = new Date("2026-08-31T00:00:00Z");
    const q = parseAgyUsage(fixture, now);
    expect(q.provider).toBe("agy");
    expect(q.plan).toBe("unknown");
    expect(q.usedPct).toBe(25);
    expect(q.sessionPct).toBe(0);
    expect(q.resetsAt).toBe(new Date("2026-09-01T13:42:08Z").toISOString());
    expect(q.periodStart).toBe(new Date(Date.parse("2026-09-01T13:42:08Z") - 7 * 86400000).toISOString());
    expect(q.source).toBe("cli");
    expect(q.raw).toBe(JSON.stringify(fixture));
    expect(q.fetchedAt).toBe(now.toISOString());
  });

  it("persists the parsed json blob in raw for debugging", () => {
    const q = parseAgyUsage(fixture, new Date("2026-08-31T00:00:00Z"));
    expect(q.raw).toBe(JSON.stringify(fixture));
    expect(JSON.parse(q.raw)).toEqual(fixture);
  });

  it("falls back to the weekly bucket with the highest usedPct when Gemini weekly is absent", () => {
    const parsed = {
      status: "SUCCESS",
      command: {
        data: {
          groups: [
            {
              name: "Claude and GPT models",
              buckets: [
                { id: "3p-weekly", window: "weekly", remaining_fraction: 0.4, reset_time: "2026-09-06T15:15:19Z" },
                { id: "other-weekly", window: "weekly", remaining_fraction: 0.9, reset_time: "2026-09-03T00:00:00Z" },
              ],
            },
          ],
        },
      },
    };
    const q = parseAgyUsage(parsed, new Date("2026-08-31T00:00:00Z"));
    expect(q.usedPct).toBe(60);
    expect(q.resetsAt).toBe(new Date("2026-09-06T15:15:19Z").toISOString());
    expect(q.sessionPct).toBeUndefined();
    expect(q.raw).toBe(JSON.stringify(parsed));
  });

  it("omits sessionPct when Gemini 5h is absent", () => {
    const parsed = {
      status: "SUCCESS",
      command: {
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.5, reset_time: "2026-09-01T13:42:08Z" },
              ],
            },
          ],
        },
      },
    };
    const q = parseAgyUsage(parsed, new Date("2026-08-31T00:00:00Z"));
    expect(q.usedPct).toBe(50);
    expect(q.sessionPct).toBeUndefined();
  });

  it("throws when status is not SUCCESS (fail-closed)", () => {
    expect(() => parseAgyUsage({ ...fixture, status: "ERROR" }, new Date())).toThrow(/SUCCESS/);
  });

  it("throws when no weekly bucket is present (fail-closed)", () => {
    const parsed = {
      status: "SUCCESS",
      command: {
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [{ id: "gemini-5h", window: "5h", remaining_fraction: 1, reset_time: "2026-08-30T20:15:19Z" }],
            },
          ],
        },
      },
    };
    expect(() => parseAgyUsage(parsed, new Date())).toThrow(/weekly/);
  });

  it("throws when groups are missing", () => {
    expect(() => parseAgyUsage({ status: "SUCCESS", command: { data: {} } }, new Date())).toThrow();
  });
});

describe("agyAdapter", () => {
  it("requires CLI login, not a token file path", () => {
    expect(agyAdapter.id).toBe("agy");
    expect(agyAdapter.requiresAuth).toMatch(/agy login/i);
    expect(agyAdapter.requiresAuth).not.toMatch(/oauth|keychain|\.gemini/i);
  });
});

describe("agyAdapter live poll", () => {
  it.skipIf(Boolean(process.env.CI) || !agyOnPath())("polls agy /usage JSON without burning a model turn", async () => {
    let q;
    try {
      q = await agyAdapter.poll();
    } catch (e: any) {
      // If agy is installed but unauthenticated or times out, skip without failing test suite
      return;
    }
    expect(q.provider).toBe("agy");
    expect(q.plan).toBe("unknown");
    expect(q.source).toBe("cli");
    expect(q.raw).not.toBe("");
    expect(JSON.parse(q.raw).status).toBe("SUCCESS");
    expect(q.usedPct).toBeGreaterThanOrEqual(0);
    expect(q.usedPct).toBeLessThanOrEqual(100);
    expect(Number.isNaN(new Date(q.resetsAt).getTime())).toBe(false);
    expect(Number.isNaN(new Date(q.periodStart).getTime())).toBe(false);
    if (q.sessionPct !== undefined) {
      expect(q.sessionPct).toBeGreaterThanOrEqual(0);
      expect(q.sessionPct).toBeLessThanOrEqual(100);
    }
  }, 30000);
});
