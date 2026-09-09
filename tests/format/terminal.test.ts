import { describe, it, expect } from "vitest";
import type { Quota } from "../../src/adapters/types.js";
import type {
  Advisory,
  AttemptRecord,
  ProviderSnapshot,
  StateSnapshot,
} from "../../src/advisory/types.js";
import {
  buildRow,
  compactSuffix,
  countdownText,
  elapsedPct,
  forecastText,
  railCells,
  sortProviders,
  stateWord,
} from "../../src/format/rows.js";
import {
  provWidthFor,
  renderCompact,
  renderNarrow,
  renderWide,
} from "../../src/format/terminal.js";
import {
  FIXED_NOW,
  RT,
  exampleStateSnapshot,
  resetPassedStateSnapshot,
  staleStateSnapshot,
  unknownPaceStateSnapshot,
} from "../fixtures/stable-state.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const RESETS = "2026-09-14T06:00:00+10:00"; // FIXED_NOW + 7d
const START = "2026-08-31T06:00:00+10:00"; // FIXED_NOW - 7d

function quota(over: Partial<Quota> = {}): Quota {
  return {
    provider: "x",
    plan: "p",
    usedPct: 10,
    resetsAt: RESETS,
    periodStart: START,
    source: "cli",
    fetchedAt: FIXED_NOW.toISOString(),
    ...over,
  };
}

function advisory(over: Partial<Advisory> = {}): Advisory {
  return {
    provider: "x",
    daysLeft: 7,
    remaining: 90,
    idealRate: 12,
    burnRate: 3,
    burnMeasured: false,
    paceSource: "window-average",
    daysToExhaust: 30,
    status: "on track",
    wastePct: 60,
    urgency: "save",
    ...over,
  };
}

function ps(over: Partial<ProviderSnapshot> & { id: string }): ProviderSnapshot {
  return {
    enabled: true,
    quota: null,
    lastAttempt: null,
    lastSuccessAt: null,
    reporting: false,
    stale: false,
    resetPassed: false,
    ageMs: null,
    evidence: [],
    exclusionReason: null,
    advisory: null,
    ...over,
  };
}

function attempt(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    provider: "x",
    attemptedAt: FIXED_NOW.toISOString(),
    completedAt: FIXED_NOW.toISOString(),
    succeededAt: FIXED_NOW.toISOString(),
    success: true,
    failureCategory: null,
    ...over,
  };
}

function snap(providers: ProviderSnapshot[], use = "none"): StateSnapshot {
  return {
    asOf: FIXED_NOW.toISOString(),
    runtime: { ...RT },
    providers,
    recommendation: {
      use,
      reason: "",
      wastePct: null,
      idealRate: 0,
      recommendationBasis: "none",
      alternatives: [],
      advisories: [],
    },
  };
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("countdowns (D7)", () => {
  const cases: Array<[string, string | null, string]> = [
    ["7d exact", RESETS, "7d"],
    ["12h", new Date(FIXED_NOW.getTime() + 12 * HOUR).toISOString(), "12h"],
    ["45m", new Date(FIXED_NOW.getTime() + 45 * 60_000).toISOString(), "45m"],
    ["48h boundary shows days", new Date(FIXED_NOW.getTime() + 48 * HOUR).toISOString(), "2d"],
    ["47h shows hours", new Date(FIXED_NOW.getTime() + 47 * HOUR).toISOString(), "47h"],
    ["90m boundary shows hours", new Date(FIXED_NOW.getTime() + 90 * 60_000).toISOString(), "1h"],
    ["89m shows minutes", new Date(FIXED_NOW.getTime() + 89 * 60_000).toISOString(), "89m"],
    ["past reset", new Date(FIXED_NOW.getTime() - HOUR).toISOString(), "passed"],
    ["unparseable", "not-a-date", "—"],
  ];
  for (const [name, resetsAt, expected] of cases) {
    it(name, () => {
      expect(countdownText(ps({ id: "x", quota: quota({ resetsAt: resetsAt! }) }), FIXED_NOW)).toBe(
        expected,
      );
    });
  }
  it("missing quota has no countdown", () => {
    expect(countdownText(ps({ id: "x" }), FIXED_NOW)).toBe("—");
  });
  it("estimated resets append (est.)", () => {
    expect(
      countdownText(
        ps({ id: "x", quota: quota({ resetsAtEstimated: true }) }),
        FIXED_NOW,
      ),
    ).toBe("7d (est.)");
  });
});

describe("elapsed percent (D7)", () => {
  it("computes window-elapsed for the example window", () => {
    expect(elapsedPct(ps({ id: "x", quota: quota() }), FIXED_NOW)).toBe(50);
  });
  it("caps past-reset windows at 100", () => {
    const kimi = resetPassedStateSnapshot.providers.find((p) => p.id === "kimi")!;
    expect(elapsedPct(kimi, FIXED_NOW)).toBe(100);
  });
  it("floors unstarted windows at 0", () => {
    const q = quota({
      periodStart: new Date(FIXED_NOW.getTime() + DAY).toISOString(),
      resetsAt: new Date(FIXED_NOW.getTime() + 8 * DAY).toISOString(),
    });
    expect(elapsedPct(ps({ id: "x", quota: q }), FIXED_NOW)).toBe(0);
  });
  it("is null when uncomputable", () => {
    expect(elapsedPct(ps({ id: "x" }), FIXED_NOW)).toBeNull();
    expect(elapsedPct(ps({ id: "x", quota: quota({ resetsAt: "not-a-date" }) }), FIXED_NOW)).toBeNull();
    expect(elapsedPct(ps({ id: "x", quota: quota({ periodStart: "not-a-date" }) }), FIXED_NOW)).toBeNull();
    expect(
      elapsedPct(ps({ id: "x", quota: quota({ periodStart: RESETS, resetsAt: RESETS }) }), FIXED_NOW),
    ).toBeNull();
  });
});

describe("rail geometry (D9)", () => {
  it("places fill and tick for the example kimi row", () => {
    const kimi = exampleStateSnapshot.providers.find((p) => p.id === "kimi")!;
    const cells = railCells(kimi, FIXED_NOW);
    expect(cells).toHaveLength(20);
    // used 22 -> 4 fill cells; elapsed 50 -> tick at round(0.5*19) = 10
    expect(cells.slice(0, 4)).toEqual(["used", "used", "used", "used"]);
    expect(cells[10]).toBe("tick");
    expect(cells.filter((c) => c === "tick")).toHaveLength(1);
    expect(cells.filter((c) => c === "used")).toHaveLength(4);
  });
  it("tick overwrites fill when elapsed trails usage", () => {
    const cells = railCells(
      ps({ id: "x", quota: quota({ usedPct: 50 }), reporting: true, advisory: advisory() }),
      new Date(START), // elapsed 0 -> tick at 0
    );
    expect(cells[0]).toBe("tick");
    expect(cells.filter((c) => c === "tick")).toHaveLength(1);
  });
  it("excluded rows render an empty rail with no tick", () => {
    for (const s of [staleStateSnapshot, resetPassedStateSnapshot, exampleStateSnapshot]) {
      for (const p of s.providers) {
        if (p.exclusionReason === null) continue;
        expect(railCells(p, FIXED_NOW)).toEqual(new Array(20).fill("unused"));
      }
    }
  });
  it("reporting rows with unknown elapsed have fill but no tick", () => {
    const p = ps({
      id: "x",
      quota: quota({ usedPct: 40, periodStart: "not-a-date" }),
      reporting: true,
      advisory: advisory(),
    });
    const cells = railCells(p, FIXED_NOW);
    expect(cells.filter((c) => c === "tick")).toHaveLength(0);
    expect(cells.filter((c) => c === "used")).toHaveLength(8);
  });
});

describe("STATE words follow the shared badge mapping", () => {
  it("any exclusion reads Not reporting", () => {
    for (const reason of ["not-reporting", "stale", "reset-passed", "invalid", "provider-failed"] as const) {
      const p = ps({
        id: "x",
        quota: reason === "not-reporting" ? null : quota(),
        exclusionReason: reason,
        // A stale row still carries an advisory; exclusion wins regardless.
        advisory: reason === "stale" ? advisory({ urgency: "save" }) : null,
      });
      expect(stateWord(p)).toBe("Not reporting");
    }
  });
  it("at-risk status reads Cap risk", () => {
    expect(
      stateWord(ps({ id: "x", quota: quota(), advisory: advisory({ status: "at risk", urgency: "slow down" }) })),
    ).toBe("Cap risk");
  });
  const urgencyCases: Array<[Advisory["urgency"], string]> = [
    ["burn now", "Behind pace"],
    ["use soon", "Behind pace"],
    ["save", "Behind pace"],
    ["slow down", "Ahead of pace"],
    ["on track", "On track"],
  ];
  for (const [urgency, expected] of urgencyCases) {
    it(`urgency ${urgency} reads ${expected}`, () => {
      expect(
        stateWord(ps({ id: "x", quota: quota(), advisory: advisory({ urgency }) })),
      ).toBe(expected);
    });
  }
  it("unknown pace keeps the locked On track word (disambiguated by forecast and compact ?)", () => {
    const agy = exampleStateSnapshot.providers.find((p) => p.id === "agy")!;
    expect(agy.advisory?.paceSource).toBe("unknown");
    expect(stateWord(agy)).toBe("On track");
  });
});

describe("forecast sentences (D7)", () => {
  it("reporting rows carry the engine waste sentence", () => {
    const kimi = exampleStateSnapshot.providers.find((p) => p.id === "kimi")!;
    expect(forecastText(kimi, FIXED_NOW)).toBe("56% waste in 7.0d");
  });
  it("unknown pace shows no numeric rate and no predicted-waste phrasing", () => {
    const kimi = unknownPaceStateSnapshot.providers.find((p) => p.id === "kimi")!;
    expect(kimi.advisory?.paceSource).toBe("unknown");
    const text = forecastText(kimi, FIXED_NOW);
    expect(text).toBe("Measuring pace; 78% remains with 7.0d until reset");
    expect(text).not.toMatch(/waste/i);
    expect(text).not.toMatch(/%\/day/);
    expect(text).not.toMatch(/per day/i);
  });
  it("zero-waste rows forecast exhaustion without inventing a rate", () => {
    const p = ps({
      id: "x",
      quota: quota({ usedPct: 90 }),
      reporting: true,
      advisory: advisory({ status: "at risk", wastePct: 0, urgency: "slow down" }),
    });
    expect(forecastText(p, FIXED_NOW)).toBe("Exhausts before reset");
  });
  it("estimated resets use the engine estimate vocabulary", () => {
    const codex = exampleStateSnapshot.providers.find((p) => p.id === "codex")!;
    expect(forecastText(codex, FIXED_NOW)).toBe("20% estimated waste in 7.0d");
  });
  it("excluded rows carry the specific exclusion note", () => {
    const staleKimi = staleStateSnapshot.providers.find((p) => p.id === "kimi")!;
    expect(forecastText(staleKimi, FIXED_NOW)).toBe("stale 3h ago");
    const passedKimi = resetPassedStateSnapshot.providers.find((p) => p.id === "kimi")!;
    expect(forecastText(passedKimi, FIXED_NOW)).toBe("reset passed — awaiting fresh window");
    const grok = exampleStateSnapshot.providers.find((p) => p.id === "grok")!;
    expect(forecastText(grok, FIXED_NOW)).toBe("invalid reading");
    const manual = exampleStateSnapshot.providers.find((p) => p.id === "manual")!;
    expect(forecastText(manual, FIXED_NOW)).toBe("no readings yet");
  });
  it("provider-failed names the sanitized category", () => {
    const failed = (category: AttemptRecord["failureCategory"]) =>
      ps({
        id: "x",
        quota: quota(),
        exclusionReason: "provider-failed",
        lastAttempt: attempt({ success: false, succeededAt: null, failureCategory: category }),
      });
    expect(forecastText(failed("auth"), FIXED_NOW)).toBe("provider failed (auth)");
    expect(forecastText(failed(null), FIXED_NOW)).toBe("provider failed");
  });
});

describe("compact suffix legend (D5)", () => {
  const cases: Array<[string, Partial<ProviderSnapshot>, string]> = [
    ["on track has no suffix", { quota: quota(), advisory: advisory({ urgency: "on track", wastePct: 0, status: "on track" }) }, ""],
    ["cap risk", { quota: quota(), advisory: advisory({ status: "at risk", wastePct: 0 }) }, "!"],
    ["behind pace", { quota: quota(), advisory: advisory({ urgency: "save" }) }, "~"],
    ["ahead of pace", { quota: quota(), advisory: advisory({ urgency: "slow down", status: "on track" }) }, "~"],
    ["estimated reset", { quota: quota({ resetsAtEstimated: true }), advisory: advisory({ urgency: "on track", wastePct: 0, status: "on track" }) }, "~"],
    ["unknown pace", { quota: quota(), advisory: advisory({ paceSource: "unknown", burnRate: null, wastePct: null, status: "unknown", urgency: "on track" }) }, "?"],
    ["excluded", { quota: quota(), exclusionReason: "stale", advisory: advisory() }, "?"],
    ["not reporting", { exclusionReason: "not-reporting" }, "?"],
  ];
  for (const [name, over, expected] of cases) {
    it(name, () => {
      expect(compactSuffix(ps({ id: "x", ...over }))).toBe(expected);
    });
  }
});

describe("buildRow composes one presentation row", () => {
  it("maps the example kimi snapshot to shared words and numbers", () => {
    const kimi = exampleStateSnapshot.providers.find((p) => p.id === "kimi")!;
    expect(buildRow(kimi, FIXED_NOW)).toEqual({
      id: "kimi",
      state: "Behind pace",
      countdown: "7d",
      forecast: "56% waste in 7.0d",
      elapsedPct: 50,
      usedPct: 22,
      railCells: railCells(kimi, FIXED_NOW),
    });
  });
  it("maps the invalid grok snapshot without throwing", () => {
    const grok = exampleStateSnapshot.providers.find((p) => p.id === "grok")!;
    const row = buildRow(grok, FIXED_NOW);
    expect(row.state).toBe("Not reporting");
    expect(row.forecast).toBe("invalid reading");
    expect(row.countdown).toBe("—");
    expect(row.elapsedPct).toBeNull();
    expect(row.usedPct).toBe(30);
  });
});

describe("recommended sort (D6)", () => {
  const ids = (s: StateSnapshot) =>
    sortProviders(s.providers, "recommended", s.recommendation.use).map((p) => p.id);
  it("orders the example fixture: recommended, waste desc, excluded last", () => {
    expect(ids(exampleStateSnapshot)).toEqual([
      "my-plan",
      "kimi",
      "claude",
      "codex",
      "agy",
      "agy:3p",
      "grok",
      "manual",
    ]);
  });
  it("keeps waste ties in snapshot order", () => {
    const order = ids(exampleStateSnapshot);
    expect(order.indexOf("claude")).toBeLessThan(order.indexOf("codex"));
  });
  it("puts unknown-pace waste nulls after measured rows", () => {
    const order = ids(exampleStateSnapshot);
    expect(order.indexOf("agy")).toBeGreaterThan(order.indexOf("codex"));
    expect(order.indexOf("agy")).toBeLessThan(order.indexOf("agy:3p"));
  });
});

describe("value sorts (D6)", () => {
  const ids = (s: StateSnapshot, key: "reset-asc" | "reset-desc" | "used-desc" | "used-asc") =>
    sortProviders(s.providers, key, s.recommendation.use).map((p) => p.id);
  it("reset-asc puts the passed reset first and invalid dates last", () => {
    expect(ids(resetPassedStateSnapshot, "reset-asc")).toEqual([
      "kimi",
      "agy",
      "agy:3p",
      "claude",
      "codex",
      "my-plan",
      "grok",
      "manual",
    ]);
  });
  it("reset-desc puts the passed reset last among valid dates", () => {
    expect(ids(resetPassedStateSnapshot, "reset-desc")).toEqual([
      "agy",
      "agy:3p",
      "claude",
      "codex",
      "my-plan",
      "kimi",
      "grok",
      "manual",
    ]);
  });
  it("used-desc orders by usage with missing readings last", () => {
    expect(ids(exampleStateSnapshot, "used-desc")).toEqual([
      "agy:3p",
      "agy",
      "claude",
      "codex",
      "grok",
      "kimi",
      "my-plan",
      "manual",
    ]);
  });
  it("used-asc orders by usage ascending with missing readings last", () => {
    expect(ids(exampleStateSnapshot, "used-asc")).toEqual([
      "my-plan",
      "kimi",
      "grok",
      "claude",
      "codex",
      "agy",
      "agy:3p",
      "manual",
    ]);
  });
  it("invalid keys throw invalid-argument", () => {
    expect(() => sortProviders([], "bogus" as never, "none")).toThrow(/invalid-argument/);
  });
});

describe("provider width", () => {
  it("clamps the example fixture to the 12 minimum", () => {
    expect(provWidthFor(exampleStateSnapshot.providers.map((p) => p.id))).toBe(12);
  });
  it("grows with raw names including the 2-char prefix", () => {
    expect(provWidthFor(["a-long-provider"])).toBe(2 + "a-long-provider".length);
  });
  it("caps at 22", () => {
    expect(provWidthFor(["a".repeat(30)])).toBe(22);
  });
});

describe("wide table", () => {
  const wide = () => strip(renderWide(exampleStateSnapshot, { now: FIXED_NOW })).split("\n");
  // Cells joined with the 2-space gap so padding stays reviewable per cell.
  const line = (cells: string[]) => cells.join("  ");
  it("renders the header plus one row per provider", () => {
    const lines = wide();
    expect(lines).toHaveLength(1 + exampleStateSnapshot.providers.length);
    expect(lines[0]).toBe(
      line(["PROVIDER    ", "  USED", " ELAPSED", "USED VS TIME        ", "RESETS   ", "STATE          ", "FORECAST"]),
    );
  });
  it("pins the recommended row exactly", () => {
    expect(wide()[1]).toBe(
      line(["★ my-plan   ", "   12%", "     50%", "██░░░░░░░░│░░░░░░░░░", "7d       ", "Behind pace    ", "76% waste in 7.0d"]),
    );
  });
  it("pins reporting, unknown-pace, stale, invalid, and not-reporting rows", () => {
    const lines = wide();
    expect(lines[2]).toBe(
      line(["  kimi      ", "   22%", "     50%", "████░░░░░░│░░░░░░░░░", "7d       ", "Behind pace    ", "56% waste in 7.0d"]),
    );
    expect(lines[5]).toBe(
      line(["  agy       ", "   50%", "      0%", "│█████████░░░░░░░░░░", "7d       ", "On track       ", "Measuring pace; 50% remains with 7.0d until reset"]),
    );
    expect(lines[6]).toBe(
      line(["  agy:3p    ", "   60%", "      0%", "░░░░░░░░░░░░░░░░░░░░", "7d       ", "Not reporting  ", "stale 3h ago"]),
    );
    expect(lines[7]).toBe(
      line(["  grok      ", "   30%", "       —", "░░░░░░░░░░░░░░░░░░░░", "—        ", "Not reporting  ", "invalid reading"]),
    );
    expect(lines[8]).toBe(
      line(["  manual    ", "     —", "       —", "░░░░░░░░░░░░░░░░░░░░", "—        ", "Not reporting  ", "no readings yet"]),
    );
  });
  it("every row honors the column contract", () => {
    for (const line of wide().slice(1)) {
      expect(line.slice(0, 12)).toMatch(/^.{12}$/);
      expect(line.slice(12, 14)).toBe("  ");
      expect(line.slice(14, 20)).toMatch(/^ *(?:\d+%|—)$/);
      expect(line.slice(20, 22)).toBe("  ");
      expect(line.slice(22, 30)).toMatch(/^ *(?:\d+%|—)$/);
      expect(line.slice(30, 32)).toBe("  ");
      expect(line.slice(32, 52)).toMatch(/^[█│░]{20}$/);
      expect(line.slice(52, 54)).toBe("  ");
      expect(line.slice(54, 63)).toMatch(/^.{1,9}$/);
      expect(line.slice(63, 65)).toBe("  ");
      expect(line.slice(65, 80)).toMatch(/^(?:On track|Behind pace|Ahead of pace|Cap risk|Not reporting) *$/);
      expect(line.slice(80, 82)).toBe("  ");
      expect(line.slice(82).length).toBeGreaterThan(0);
    }
  });
  it("honors the requested sort key", () => {
    const lines = strip(renderWide(exampleStateSnapshot, { now: FIXED_NOW, sort: "used-asc" })).split("\n");
    expect(lines[1].slice(0, 12)).toBe("★ my-plan   ");
    expect(lines[2].slice(0, 12)).toBe("  kimi      ");
  });
  it("truncates names past 22 cells with an ellipsis", () => {
    const s = snap(
      [ps({ id: "a".repeat(30), quota: quota({ provider: "a".repeat(30) }), reporting: true, advisory: advisory() })],
      "none",
    );
    const line = strip(renderWide(s, { now: FIXED_NOW })).split("\n")[1];
    expect(line.slice(0, 22)).toBe(`  ${"a".repeat(19)}…`);
  });
  it("emits no ANSI without color and identical text with color stripped", () => {
    const plain = renderWide(exampleStateSnapshot, { now: FIXED_NOW });
    expect(plain).not.toContain("\x1b[");
    expect(plain).toContain("█");
    const colored = renderWide(exampleStateSnapshot, { now: FIXED_NOW, color: true });
    expect(colored).toContain("\x1b[");
    expect(strip(colored)).toBe(plain);
  });
  it("--ascii uses ASCII glyphs without ANSI", () => {
    const out = renderWide(exampleStateSnapshot, { now: FIXED_NOW, ascii: true });
    expect(out).not.toContain("\x1b[");
    expect(out).not.toMatch(/[█│░★…·—]/);
    const lines = out.split("\n");
    expect(lines[1].slice(0, 12)).toBe("* my-plan   ");
    expect(lines[1].slice(32, 52)).toBe("##::::::::|:::::::::");
  });
});

describe("narrow table (D8)", () => {
  const narrow = () => strip(renderNarrow(exampleStateSnapshot, { now: FIXED_NOW })).split("\n");
  it("renders two lines per provider in recommended order", () => {
    const lines = narrow();
    expect(lines).toHaveLength(2 * exampleStateSnapshot.providers.length);
    expect(lines[0]).toBe("★ my-plan    12% used · 50% elapsed");
    expect(lines[1]).toBe("██░░░░░░░░│░░░░░░░░░ resets 7d · Behind pace · 76% waste in 7.0d");
  });
  it("renders unknown values without placeholders leaking percents", () => {
    const lines = narrow();
    expect(lines[14]).toBe("  manual     — used · — elapsed");
    expect(lines[15]).toBe("░░░░░░░░░░░░░░░░░░░░ resets — · Not reporting · no readings yet");
  });
  it("keeps the wide provider width, colors, and words", () => {
    const colored = renderNarrow(exampleStateSnapshot, { now: FIXED_NOW, color: true });
    expect(colored).toContain("\x1b[");
    expect(strip(colored).split("\n")[0].slice(0, 12)).toBe("★ my-plan   ");
    expect(narrow()[3]).toContain("Behind pace");
  });
  it("--ascii replaces separators and glyphs", () => {
    const lines = renderNarrow(exampleStateSnapshot, { now: FIXED_NOW, ascii: true }).split("\n");
    expect(lines[0]).toBe("* my-plan    12% used - 50% elapsed");
    expect(lines[1]).toBe("##::::::::|::::::::: resets 7d - Behind pace - 76% waste in 7.0d");
  });
});

describe("compact statusline (D5)", () => {
  it("pins the example fixture exactly and stays ASCII-only", () => {
    const out = renderCompact(exampleStateSnapshot, FIXED_NOW);
    expect(out).toBe(
      "[my-plan:12%~] | [kimi:22%~] | [claude:40%~] | [codex:40%~] | [agy:50%?] | [agy:3p:60%?] | [grok:30%?]  (use: my-plan)",
    );
    expect(out).not.toContain("\x1b[");
    for (const ch of out) expect(ch.charCodeAt(0)).toBeLessThan(128);
  });
  it("prints (use: none) with no readings", () => {
    const s = snap([ps({ id: "manual", exclusionReason: "not-reporting" })], "none");
    expect(renderCompact(s, FIXED_NOW)).toBe("(use: none)");
  });
});
