import { describe, expect, it } from "vitest";
import type { ProviderSnapshot } from "../../src/advisory/types.js";
import { forecastText, stateWord } from "../../src/format/rows.js";
import {
  limitStamp,
  rateLimitWaits,
  type RateLimitSource,
} from "../../src/format/rate-limit-wait.js";
import { renderRecommendationSummary } from "../../src/format/markdown.js";
import { renderWide } from "../../src/format/terminal.js";
import { emptyCatalog } from "../../src/catalog/types.js";
import { exampleStateSnapshot } from "../fixtures/stable-state.js";

const NOW = new Date("2026-10-23T08:00:00.000Z");
const IN_THREE_HOURS = new Date(NOW.getTime() + 3 * 3_600_000).toISOString();
const IN_SIX_DAYS = new Date(NOW.getTime() + 6 * 86_400_000).toISOString();
const HOUR_AGO = new Date(NOW.getTime() - 3_600_000).toISOString();

function source(over: Partial<RateLimitSource> = {}): RateLimitSource {
  return {
    exclusionReason: null,
    ...over,
    quota: {
      weeklyPct: 19,
      resetsAt: IN_SIX_DAYS,
      fiveHourPct: 12,
      ...over.quota,
    },
  };
}

describe("limitStamp", () => {
  it("prints weekday, date, and 24-hour time", () => {
    const stamp = limitStamp(IN_THREE_HOURS);
    const when = new Date(IN_THREE_HOURS);
    expect(stamp).toBe(
      [
        when.toLocaleDateString("en-US", { weekday: "short" }),
        when.toLocaleDateString("en-US", { month: "short" }),
        when.toLocaleDateString("en-US", { day: "numeric" }),
        stamp!.split(" ").at(-1),
      ].join(" "),
    );
    expect(stamp).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/);
  });
});

describe("rateLimitWaits", () => {
  it("names a full 5h window with the date and time it clears", () => {
    const waits = rateLimitWaits(
      source({ quota: { fiveHourPct: 100, fiveHourResetsAt: IN_THREE_HOURS } }),
      NOW,
    );
    expect(waits).toEqual([
      {
        window: "five-hour",
        label: "5h limit",
        resetsAt: IN_THREE_HOURS,
        until: limitStamp(IN_THREE_HOURS),
        text: `5h limit until ${limitStamp(IN_THREE_HOURS)}`,
      },
    ]);
  });

  it("says the 5h limit is reached when the provider did not report a finish time", () => {
    const waits = rateLimitWaits(source({ quota: { fiveHourPct: 100 } }), NOW);
    expect(waits.map((w) => w.text)).toEqual(["5h limit reached"]);
  });

  it("drops a 5h window whose reset has already passed", () => {
    expect(
      rateLimitWaits(
        source({ quota: { fiveHourPct: 100, fiveHourResetsAt: HOUR_AGO } }),
        NOW,
      ),
    ).toEqual([]);
  });

  it("stays quiet below 100 and on an excluded row", () => {
    expect(rateLimitWaits(source({ quota: { fiveHourPct: 99, fiveHourResetsAt: IN_THREE_HOURS } }), NOW)).toEqual([]);
    expect(
      rateLimitWaits(
        source({
          exclusionReason: "stale",
          quota: { fiveHourPct: 100, fiveHourResetsAt: IN_THREE_HOURS },
        }),
        NOW,
      ),
    ).toEqual([]);
  });

  it("names a full week on a monthly plan and leaves a full week on a weekly plan to the quota badge", () => {
    const monthly = source({
      quota: {
        weeklyPct: 100,
        resetsAt: IN_SIX_DAYS,
        fiveHourPct: 10,
        monthlyKind: "included",
        monthlyPct: 40,
        monthlyResetsAt: IN_SIX_DAYS,
        monthlyStatus: "ok",
      },
    });
    expect(rateLimitWaits(monthly, NOW).map((w) => w.text)).toEqual([
      `Weekly limit until ${limitStamp(IN_SIX_DAYS)}`,
    ]);

    const weeklyPlan = source({
      quota: { weeklyPct: 100, resetsAt: IN_SIX_DAYS, fiveHourPct: 100, fiveHourResetsAt: IN_THREE_HOURS },
    });
    expect(rateLimitWaits(weeklyPlan, NOW)).toEqual([]);
  });

  it("hides the short windows once the included month is exhausted", () => {
    const monthFull = source({
      quota: {
        weeklyPct: 100,
        resetsAt: IN_SIX_DAYS,
        fiveHourPct: 100,
        fiveHourResetsAt: IN_THREE_HOURS,
        monthlyKind: "included",
        monthlyPct: 100,
        monthlyResetsAt: IN_SIX_DAYS,
        monthlyStatus: "exhausted",
      },
    });
    expect(rateLimitWaits(monthFull, NOW)).toEqual([]);
  });

  it("lists the 5h block before a later weekly block", () => {
    const both = source({
      quota: {
        weeklyPct: 100,
        resetsAt: IN_SIX_DAYS,
        fiveHourPct: 100,
        fiveHourResetsAt: IN_THREE_HOURS,
        monthlyKind: "included",
        monthlyPct: 40,
        monthlyResetsAt: IN_SIX_DAYS,
        monthlyStatus: "ok",
      },
    });
    expect(rateLimitWaits(both, NOW).map((w) => w.window)).toEqual(["five-hour", "weekly"]);
  });

  it("reads the sessionPct alias when fiveHourPct is absent", () => {
    const waits = rateLimitWaits(
      source({ quota: { fiveHourPct: undefined, sessionPct: 100, fiveHourResetsAt: IN_THREE_HOURS } }),
      NOW,
    );
    expect(waits).toHaveLength(1);
    expect(waits[0].window).toBe("five-hour");
  });
});

describe("pace surfaces stay on the reset window", () => {
  function blockedClaude(): ProviderSnapshot {
    const claude = exampleStateSnapshot.providers.find((p) => p.id === "claude")!;
    return {
      ...claude,
      catalog: claude.catalog ?? emptyCatalog(),
      quota: claude.quota
        ? {
            ...claude.quota,
            fiveHourPct: 100,
            sessionPct: 100,
            fiveHourResetsAt: IN_THREE_HOURS,
          }
        : null,
    };
  }

  it("keeps the state word and the forecast, and appends the wait on the row", () => {
    const ps = blockedClaude();
    const plain: ProviderSnapshot = {
      ...ps,
      quota: ps.quota
        ? { ...ps.quota, fiveHourPct: 12, sessionPct: 12, fiveHourResetsAt: undefined }
        : null,
    };
    expect(stateWord(ps)).toBe(stateWord(plain));
    expect(forecastText(ps, NOW)).toBe(forecastText(plain, NOW));
    const snap = { ...exampleStateSnapshot, providers: [ps], asOf: NOW.toISOString() };
    const wide = renderWide(snap, { now: NOW });
    expect(wide).toContain(forecastText(ps, NOW));
    expect(wide).toContain(`5h limit until ${limitStamp(IN_THREE_HOURS)}`);
    expect(renderRecommendationSummary(snap, NOW)).toBe(
      [
        `${snap.recommendation.use}: ${snap.recommendation.reason}`,
        `Claude: 5h limit until ${limitStamp(IN_THREE_HOURS)}`,
      ].join("\n"),
    );
  });
});
