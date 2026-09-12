import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatInTimeZone } from "date-fns-tz";
import { parseMuseTui, museAdapter } from "../../src/adapters/muse.js";
import { stripAnsi } from "../../src/adapters/pty.js";
import * as ptyMod from "../../src/adapters/pty.js";

interface MuseFixtureOpts {
  plan?: string;
  currentPct?: number;
  currentReset?: string;
  weeklyPct?: number;
  weeklyReset?: string;
  dropWeekly?: boolean;
  dropCurrent?: boolean;
}

// Painted rows of the /usage panel, captured live at 140x50. Only the last
// three rows carry subscription quota; the session token counters are ignored.
function museRows(o?: MuseFixtureOpts): string[] {
  const rows = [
    "Session usage",
    "  Input      0",
    "  Cached     0",
    "  Output     0",
    "  Total      0",
    "  Turns         0",
    "  Subagents  none",
    `Subscription · Muse Code ${o?.plan ?? "High Usage"}`,
  ];
  if (!o?.dropCurrent) {
    rows.push(`  Current        ${o?.currentPct ?? 11}% used · Resets at ${o?.currentReset ?? "3:51 PM"}`);
  }
  if (!o?.dropWeekly) {
    rows.push(`  Weekly         ${o?.weeklyPct ?? 35}% used · Resets ${o?.weeklyReset ?? "Sep 14 at 10:00 AM"}`);
  }
  rows.push("  as of 12:34 PM");
  return rows;
}

// Raw transcript: the TUI positions with cursor moves, not newlines, so after
// ANSI stripping this is one line. No parse rule may rely on line boundaries.
function museRawTranscript(o?: MuseFixtureOpts): string {
  return "\x1b[2J\x1b[?25l" + museRows(o).map((r, i) => `\x1b[${i + 1};1H${r}`).join("");
}

const HAPPY_NOW = new Date("2026-09-12T02:00:00Z"); // 12:00 Brisbane, Sep 12

// poll() parses with the real clock, so its fixture reset must stay in the
// future no matter when the suite runs. Rendered in the panel's own shape.
function futureWeeklyReset(): string {
  return formatInTimeZone(new Date(Date.now() + 2 * 86400000), "Australia/Brisbane", "MMM d 'at' h:mm a");
}

describe("parseMuseTui", () => {
  it("maps the captured panel to all seven fields", () => {
    const q = parseMuseTui(museRawTranscript(), HAPPY_NOW);
    expect(q.provider).toBe("muse");
    expect(q.plan).toBe("High Usage");
    expect(q.usedPct).toBe(35);
    expect(q.sessionPct).toBe(11);
    expect(q.resetsAt).toBe("2026-09-14T10:00:00+10:00");
    expect(new Date(q.periodStart).getTime()).toBe(new Date(q.resetsAt).getTime() - 7 * 86400000);
    expect(q.source).toBe("tui");
    expect(q.fetchedAt).toBe(HAPPY_NOW.toISOString());
    expect(q.resetsAtEstimated).toBeUndefined();
    expect(q.creditsUsd).toBeUndefined();
    expect(q.raw).toContain("Subscription");
    expect(q.raw!.length).toBeLessThanOrEqual(4096);
  });

  it("parses single-line input with the panel embedded mid-line (no anchors)", () => {
    const line = `muse-spark-1.3 footer noise ${stripAnsi(museRawTranscript())} trailing TUI chrome`;
    expect(line).not.toContain("\n");
    const q = parseMuseTui(line, HAPPY_NOW);
    expect(q.plan).toBe("High Usage");
    expect(q.usedPct).toBe(35);
    expect(q.sessionPct).toBe(11);
    expect(q.resetsAt).toBe("2026-09-14T10:00:00+10:00");
  });

  it("collapses an overdrawn duplicate panel to one result", () => {
    const raw = `${museRawTranscript()}\x1b[H${museRawTranscript()}`;
    const q = parseMuseTui(raw, HAPPY_NOW);
    expect(q.plan).toBe("High Usage");
    expect(q.usedPct).toBe(35);
    expect(q.sessionPct).toBe(11);
    expect(q.resetsAt).toBe("2026-09-14T10:00:00+10:00");
  });

  it("still parses with a launcher update notice prepended", () => {
    const raw = `Muse Code updated 1.1.0 -> 1.1.1\n${museRawTranscript()}`;
    const q = parseMuseTui(raw, HAPPY_NOW);
    expect(q.plan).toBe("High Usage");
    expect(q.usedPct).toBe(35);
    expect(q.sessionPct).toBe(11);
    expect(q.resetsAt).toBe("2026-09-14T10:00:00+10:00");
  });

  it("throws when the Weekly line is absent (fail-closed)", () => {
    expect(() => parseMuseTui(museRawTranscript({ dropWeekly: true }), HAPPY_NOW)).toThrow(/weekly/i);
  });

  it("throws when the Current line is absent (fail-closed)", () => {
    expect(() => parseMuseTui(museRawTranscript({ dropCurrent: true }), HAPPY_NOW)).toThrow(/current/i);
  });

  it("throws when a percent is out of range (fail-closed)", () => {
    expect(() => parseMuseTui(museRawTranscript({ weeklyPct: 137 }), HAPPY_NOW)).toThrow(/bad weekly pct/);
    expect(() => parseMuseTui(museRawTranscript({ currentPct: 101 }), HAPPY_NOW)).toThrow(/bad current pct/);
  });

  it("throws on an unparseable reset with no estimated fallback (fail-closed)", () => {
    expect(() => parseMuseTui(museRawTranscript({ weeklyReset: "Feb 30 at 10:00 AM" }), HAPPY_NOW)).toThrow(
      /bad weekly reset/,
    );
  });

  it("rolls a January reset parsed in December into next year", () => {
    const decNow = new Date("2026-12-30T02:00:00Z"); // 12:00 Brisbane, Dec 30
    const q = parseMuseTui(museRawTranscript({ weeklyReset: "Jan 5 at 10:00 AM" }), decNow);
    expect(q.resetsAt).toBe("2027-01-05T10:00:00+10:00");
  });

  it("declares CLI-owned credentials", () => {
    expect(museAdapter.id).toBe("muse");
    expect(museAdapter.requiresAuth).toMatch(/muse login/);
    expect(museAdapter.requiresAuth).not.toMatch(/auth\.json/i);
  });
});

describe("museAdapter.poll invocation contract", () => {
  const oldQcHome = process.env.QUOTACAP_HOME;

  afterEach(() => {
    process.env.QUOTACAP_HOME = oldQcHome;
  });

  it("spawns muse with the measured invocation (two-phase submit, responder on)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "qc-muse-"));
    process.env.QUOTACAP_HOME = home;
    let captured: Record<string, any> = {};
    const spy = vi.spyOn(ptyMod, "runPty").mockImplementation(async (opts) => {
      captured = opts as unknown as Record<string, any>;
      return museRawTranscript({ weeklyReset: futureWeeklyReset() });
    });
    const probeDir = path.join(home, ".quotacap", "muse-probe");
    let probeExisted = false;
    try {
      const q = await museAdapter.poll();
      expect(q.provider).toBe("muse");
      expect(q.usedPct).toBe(35);
      expect(q.sessionPct).toBe(11);
      // Created on demand, under the (mocked) state dir — never $HOME itself.
      probeExisted = fs.statSync(probeDir).isDirectory();
    } finally {
      spy.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
    }
    expect(probeExisted).toBe(true);

    expect(captured["file"]).toBe("muse");
    expect(captured["args"]).toEqual(["--trust-workspace"]);
    expect(captured["env"]).toMatchObject({ MUSE_NO_AUTO_UPDATE: "1" });
    expect(captured["cwd"]).toBe(probeDir);
    expect(captured["input"]).toBe("/usage");
    expect(captured["submitInput"]).toBe("\r");
    expect(captured["submitAfterMs"]).toBe(1500);
    expect(captured["respondToQueries"]).toBe(true);
    expect(captured["settleDelayMs"]).toBe(1000);
    expect(captured["timeoutMs"]).toBe(14000);
    expect("muse-spark-1.3 footer").toMatch(captured["readyRegex"]);
    expect("Muse Code 1.1.1 header").toMatch(captured["readyRegex"]);
    expect(stripAnsi(museRawTranscript())).toMatch(captured["completionRegex"]);

    const abortOn = captured["abortOn"] as RegExp;
    expect("Do you trust this workspace? [1] Yes").toMatch(abortOn);
    expect("Working (12s) · thinking").toMatch(abortOn);
    expect("Subscriptions aren't currently available for your account.").toMatch(abortOn);
    expect("error=subscription_unavailable").toMatch(abortOn);
    expect(stripAnsi(museRawTranscript())).not.toMatch(abortOn);
  });

  it("falls back to the homedir probe dir when QUOTACAP_HOME is unset", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "qc-muse-home-"));
    delete process.env.QUOTACAP_HOME;
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
    let captured: Record<string, any> = {};
    const spy = vi.spyOn(ptyMod, "runPty").mockImplementation(async (opts) => {
      captured = opts as unknown as Record<string, any>;
      return museRawTranscript({ weeklyReset: futureWeeklyReset() });
    });
    try {
      await museAdapter.poll();
    } finally {
      spy.mockRestore();
      homedirSpy.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
    }
    expect(captured["cwd"]).toBe(path.join(home, ".quotacap", "muse-probe"));
  });
});
