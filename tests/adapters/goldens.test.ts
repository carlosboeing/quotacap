import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GOLDEN_CLI_VERSIONS, goldenFixtureDir, isGoldenCovered } from "../../src/adapters/goldens.js";
import { parseClaudeUsage } from "../../src/adapters/claude.js";
import { parseCodexTui } from "../../src/adapters/codex.js";
import { parseGrokTui } from "../../src/adapters/grok.js";

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "golden");

interface GoldenExpected {
  now: string;
  weeklyPct: number;
  fiveHourPct?: number | null;
  plan?: string;
  resetsAt?: string;
  reset?: { month: number; date: number; hours: number; minutes: number };
  resetsAtEstimated?: boolean;
}

function loadGolden(provider: string, version: string): { transcript: string; expected: GoldenExpected } {
  const dir = path.join(GOLDEN_DIR, goldenFixtureDir(provider, version));
  return {
    transcript: fs.readFileSync(path.join(dir, "transcript.txt"), "utf8"),
    expected: JSON.parse(fs.readFileSync(path.join(dir, "expected.json"), "utf8")),
  };
}

function expectResetLocal(actualIso: string, expected: NonNullable<GoldenExpected["reset"]>): void {
  const dt = new Date(actualIso);
  expect(dt.getMonth()).toBe(expected.month);
  expect(dt.getDate()).toBe(expected.date);
  expect(dt.getHours()).toBe(expected.hours);
  expect(dt.getMinutes()).toBe(expected.minutes);
}

describe("golden transcripts", () => {
  it("parses the grok 1.0.41 usage dialog", () => {
    const { transcript, expected } = loadGolden("grok", "1.0.41");
    const q = parseGrokTui(transcript, new Date(expected.now));
    expect(q.weeklyPct).toBe(expected.weeklyPct);
    expect(q.plan).toBe(expected.plan);
    expectResetLocal(q.resetsAt, expected.reset!);
    expect(q.resetsAtEstimated ?? false).toBe(expected.resetsAtEstimated);
  });

  it("parses the codex 0.157.1 /status panel", () => {
    const { transcript, expected } = loadGolden("codex", "0.157.1");
    const q = parseCodexTui(transcript, new Date(expected.now));
    expect(q.weeklyPct).toBe(expected.weeklyPct);
    expect(q.fiveHourPct).toBe(expected.fiveHourPct);
    expect(q.plan).toBe(expected.plan);
    expectResetLocal(q.resetsAt, expected.reset!);
    expect(q.resetsAtEstimated ?? false).toBe(expected.resetsAtEstimated);
  });

  it("parses the claude 2.1.283 /usage output", () => {
    const { transcript, expected } = loadGolden("claude", "2.1.283");
    const q = parseClaudeUsage(transcript, new Date(expected.now));
    expect(q.weeklyPct).toBe(expected.weeklyPct);
    expect(q.fiveHourPct).toBe(expected.fiveHourPct);
    expect(q.plan).toBe(expected.plan);
    expect(q.resetsAt).toBe(expected.resetsAt);
  });

  it("keeps the manifest and fixture dirs in sync", () => {
    const dirs = fs
      .readdirSync(GOLDEN_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const manifestDirs = Object.entries(GOLDEN_CLI_VERSIONS)
      .flatMap(([provider, versions]) => versions.map((v) => goldenFixtureDir(provider, v)))
      .sort();
    expect(manifestDirs).toEqual(dirs);
    for (const dir of dirs) {
      expect(fs.existsSync(path.join(GOLDEN_DIR, dir, "transcript.txt"))).toBe(true);
      expect(fs.existsSync(path.join(GOLDEN_DIR, dir, "expected.json"))).toBe(true);
    }
  });

  it("holds no identifiers in fixtures", () => {
    for (const provider of Object.keys(GOLDEN_CLI_VERSIONS)) {
      for (const version of GOLDEN_CLI_VERSIONS[provider]) {
        const { transcript } = loadGolden(provider, version);
        expect(transcript).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
        expect(transcript).not.toContain("carlos");
        expect(transcript).not.toContain("01a0e664");
      }
    }
  });
});

describe("isGoldenCovered", () => {
  it("matches full --version strings by substring", () => {
    expect(isGoldenCovered("grok", "grok 1.0.41 (4220f3b224a6) [stable]")).toBe(true);
    expect(isGoldenCovered("codex", "codex-cli 0.157.1")).toBe(true);
    expect(isGoldenCovered("claude", "2.1.283 (Claude Code)")).toBe(true);
    expect(isGoldenCovered("grok", "grok 1.0.42")).toBe(false);
    expect(isGoldenCovered("kimi", "kimi 1.2.3")).toBe(false);
    expect(isGoldenCovered("grok", null)).toBe(false);
    expect(isGoldenCovered("grok", undefined)).toBe(false);
  });
});
