import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { parseAgyUsage, agyAdapter, agy3pAdapter } from "../../src/adapters/agy.js";
import { recommend } from "../../src/advisory/engine.js";
import type { Quota } from "../../src/adapters/types.js";

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

const brainstormFixture = {
  status: "SUCCESS",
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          description: "Models within this group: Gemini Flash, Gemini Pro",
          buckets: [
            {
              id: "gemini-weekly",
              window: "weekly",
              remaining_fraction: 0.5694,
              reset_time: "2026-09-01T13:42:08Z",
            },
            {
              id: "gemini-5h",
              window: "5h",
              remaining_fraction: 0.9211,
              reset_time: "2026-09-01T06:52:56Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
          buckets: [
            {
              id: "3p-weekly",
              window: "weekly",
              remaining_fraction: 0.6066,
              reset_time: "2026-09-07T07:04:27Z",
            },
            {
              id: "3p-5h",
              window: "5h",
              remaining_fraction: 0.8213,
              reset_time: "2026-09-01T07:40:58Z",
            },
          ],
        },
      ],
    },
  },
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
  it("maps Gemini weekly remaining_fraction to usedPct and 5h to sessionPct for agy row, and 3p for agy:3p row", () => {
    const now = new Date("2026-08-31T00:00:00Z");
    const rows = parseAgyUsage(fixture, now);
    expect(rows).toHaveLength(2);

    const [gemini, threeP] = rows;
    expect(gemini.provider).toBe("agy");
    expect(gemini.plan).toBe("unknown");
    expect(gemini.usedPct).toBe(25);
    expect(gemini.sessionPct).toBe(0);
    expect(gemini.resetsAt).toBe(new Date("2026-09-01T13:42:08Z").toISOString());
    expect(gemini.periodStart).toBe(new Date(Date.parse("2026-09-01T13:42:08Z") - 7 * 86400000).toISOString());
    expect(gemini.source).toBe("cli");
    expect(gemini.raw).toBe(JSON.stringify(fixture));
    expect(gemini.fetchedAt).toBe(now.toISOString());

    expect(threeP.provider).toBe("agy:3p");
    expect(threeP.plan).toBe("unknown");
    expect(threeP.usedPct).toBe(0);
    expect(threeP.sessionPct).toBe(0);
    expect(threeP.resetsAt).toBe(new Date("2026-09-06T15:15:19Z").toISOString());
    expect(threeP.periodStart).toBe(new Date(Date.parse("2026-09-06T15:15:19Z") - 7 * 86400000).toISOString());
    expect(threeP.source).toBe("cli");
    expect(threeP.raw).toBe(JSON.stringify(fixture));
    expect(threeP.fetchedAt).toBe(now.toISOString());
  });

  it("emits both rows from the brainstorm live JSON fixture", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const rows = parseAgyUsage(brainstormFixture, now);
    expect(rows).toHaveLength(2);

    const [gemini, threeP] = rows;
    expect(gemini.provider).toBe("agy");
    expect(gemini.usedPct).toBe(43);
    expect(gemini.sessionPct).toBe(8);
    expect(gemini.resetsAt).toBe("2026-09-01T13:42:08.000Z");
    expect(gemini.periodStart).toBe(new Date(Date.parse("2026-09-01T13:42:08Z") - 7 * 86400000).toISOString());
    expect(gemini.source).toBe("cli");

    expect(threeP.provider).toBe("agy:3p");
    expect(threeP.usedPct).toBe(39);
    expect(threeP.sessionPct).toBe(18);
    expect(threeP.resetsAt).toBe("2026-09-07T07:04:27.000Z");
    expect(threeP.periodStart).toBe(new Date(Date.parse("2026-09-07T07:04:27Z") - 7 * 86400000).toISOString());
    expect(threeP.source).toBe("cli");
  });

  it("persists the parsed json blob in raw for debugging on both rows", () => {
    const rows = parseAgyUsage(fixture, new Date("2026-08-31T00:00:00Z"));
    expect(rows).toHaveLength(2);
    expect(rows[0].raw).toBe(JSON.stringify(fixture));
    expect(rows[1].raw).toBe(JSON.stringify(fixture));
    expect(JSON.parse(rows[0].raw)).toEqual(fixture);
    expect(JSON.parse(rows[1].raw)).toEqual(fixture);
  });

  it("parses 3p group when Gemini models group is absent", () => {
    const parsed = {
      status: "SUCCESS",
      command: {
        data: {
          groups: [
            {
              name: "Claude and GPT models",
              buckets: [
                { id: "3p-weekly", window: "weekly", remaining_fraction: 0.4, reset_time: "2026-09-06T15:15:19Z" },
              ],
            },
          ],
        },
      },
    };
    const rows = parseAgyUsage(parsed, new Date("2026-08-31T00:00:00Z"));
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("agy:3p");
    expect(rows[0].usedPct).toBe(60);
    expect(rows[0].resetsAt).toBe(new Date("2026-09-06T15:15:19Z").toISOString());
    expect(rows[0].sessionPct).toBeUndefined();
    expect(rows[0].raw).toBe(JSON.stringify(parsed));
  });

  it("omits sessionPct when 5h bucket is absent", () => {
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
    const rows = parseAgyUsage(parsed, new Date("2026-08-31T00:00:00Z"));
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("agy");
    expect(rows[0].usedPct).toBe(50);
    expect(rows[0].sessionPct).toBeUndefined();
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

describe("adapter registration", () => {
  it("registers agy requiring CLI login, not a token file path", () => {
    expect(agyAdapter.id).toBe("agy");
    expect(agyAdapter.requiresAuth).toMatch(/agy login/i);
    expect(agyAdapter.requiresAuth).not.toMatch(/oauth|keychain|\.gemini/i);
  });

  it("registers agy:3p requiring CLI login, not a token file path", () => {
    expect(agy3pAdapter.id).toBe("agy:3p");
    expect(agy3pAdapter.requiresAuth).toMatch(/agy login/i);
    expect(agy3pAdapter.requiresAuth).not.toMatch(/oauth|keychain|\.gemini/i);
  });
});

describe("advisory handling for agy:3p", () => {
  it("evaluates agy and agy:3p as separate providers", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const [gemini, threeP] = parseAgyUsage(brainstormFixture, now);
    const rec = recommend([gemini, threeP], "any", new Map(), now);

    expect(rec.advisories).toHaveLength(2);
    const agyAdv = rec.advisories.find((a) => a.provider === "agy");
    const threePAdv = rec.advisories.find((a) => a.provider === "agy:3p");
    expect(agyAdv).toBeDefined();
    expect(threePAdv).toBeDefined();
    expect(rec.alternatives.map((q) => q.provider).sort()).toEqual(["agy", "agy:3p"]);
  });

  it("recommends agy:3p when 3p has higher waste", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    // agy: burning fast, exhausts early, waste = 0%
    const agyQuota: Quota = {
      provider: "agy",
      plan: "unknown",
      usedPct: 80,
      periodStart: "2026-08-25T00:00:00Z",
      resetsAt: "2026-09-03T00:00:00Z",
      raw: "{}",
      source: "cli",
      fetchedAt: now.toISOString(),
    };
    // agy:3p: used 14% over 7 days (2%/day), 2 days left -> 86 - 4 = 82% waste
    const threePQuota: Quota = {
      provider: "agy:3p",
      plan: "unknown",
      usedPct: 14,
      periodStart: "2026-08-25T00:00:00Z",
      resetsAt: "2026-09-03T00:00:00Z",
      raw: "{}",
      source: "cli",
      fetchedAt: now.toISOString(),
    };
    const rec = recommend([agyQuota, threePQuota], "any", new Map(), now);
    expect(rec.use).toBe("agy:3p");
    expect(rec.advisories.find((a) => a.provider === "agy:3p")?.wastePct).toBeGreaterThan(50);
  });

  it("recommends agy when gemini has higher waste", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    // agy: used 14% over 7 days (2%/day), 2 days left -> 82% waste
    const agyQuota: Quota = {
      provider: "agy",
      plan: "unknown",
      usedPct: 14,
      periodStart: "2026-08-25T00:00:00Z",
      resetsAt: "2026-09-03T00:00:00Z",
      raw: "{}",
      source: "cli",
      fetchedAt: now.toISOString(),
    };
    // agy:3p: burning fast, exhausts early, waste = 0%
    const threePQuota: Quota = {
      provider: "agy:3p",
      plan: "unknown",
      usedPct: 80,
      periodStart: "2026-08-25T00:00:00Z",
      resetsAt: "2026-09-03T00:00:00Z",
      raw: "{}",
      source: "cli",
      fetchedAt: now.toISOString(),
    };
    const rec = recommend([agyQuota, threePQuota], "any", new Map(), now);
    expect(rec.use).toBe("agy");
    expect(rec.advisories.find((a) => a.provider === "agy")?.wastePct).toBeGreaterThan(50);
  });

  it("handles recent burn rate keyed by agy:3p", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const threePQuota: Quota = {
      provider: "agy:3p",
      plan: "unknown",
      usedPct: 50,
      periodStart: "2026-08-31T00:00:00Z",
      resetsAt: "2026-09-07T00:00:00Z",
      raw: "{}",
      source: "cli",
      fetchedAt: now.toISOString(),
    };
    const burns = new Map([["agy:3p", 25]]);
    const rec = recommend([threePQuota], "any", burns, now);
    const adv = rec.advisories[0];
    expect(adv.provider).toBe("agy:3p");
    expect(adv.burnMeasured).toBe(true);
    expect(adv.burnRate).toBe(25);
    expect(adv.status).toBe("at risk");
  });
});

describe("agyAdapter live poll", () => {
  it.skipIf(Boolean(process.env.CI) || !agyOnPath())("polls agy /usage JSON producing both agy and agy:3p rows without burning a model turn", async () => {
    let rows: any;
    try {
      rows = await agyAdapter.poll();
    } catch (e: any) {
      // If agy is installed but unauthenticated or times out, skip without failing test suite
      return;
    }
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(2);

    const [gemini, threeP] = rows;
    expect(gemini.provider).toBe("agy");
    expect(gemini.plan).toBe("unknown");
    expect(gemini.source).toBe("cli");
    expect(gemini.raw).not.toBe("");
    expect(JSON.parse(gemini.raw).status).toBe("SUCCESS");
    expect(gemini.usedPct).toBeGreaterThanOrEqual(0);
    expect(gemini.usedPct).toBeLessThanOrEqual(100);
    expect(Number.isNaN(new Date(gemini.resetsAt).getTime())).toBe(false);
    expect(Number.isNaN(new Date(gemini.periodStart).getTime())).toBe(false);
    if (gemini.sessionPct !== undefined) {
      expect(gemini.sessionPct).toBeGreaterThanOrEqual(0);
      expect(gemini.sessionPct).toBeLessThanOrEqual(100);
    }

    expect(threeP.provider).toBe("agy:3p");
    expect(threeP.plan).toBe("unknown");
    expect(threeP.source).toBe("cli");
    expect(threeP.raw).not.toBe("");
    expect(JSON.parse(threeP.raw).status).toBe("SUCCESS");
    expect(threeP.usedPct).toBeGreaterThanOrEqual(0);
    expect(threeP.usedPct).toBeLessThanOrEqual(100);
    expect(Number.isNaN(new Date(threeP.resetsAt).getTime())).toBe(false);
    expect(Number.isNaN(new Date(threeP.periodStart).getTime())).toBe(false);
    if (threeP.sessionPct !== undefined) {
      expect(threeP.sessionPct).toBeGreaterThanOrEqual(0);
      expect(threeP.sessionPct).toBeLessThanOrEqual(100);
    }

    const single3p = await agy3pAdapter.poll();
    expect(single3p.provider).toBe("agy:3p");
    expect(single3p.usedPct).toBe(threeP.usedPct);
  }, 30000);
});
