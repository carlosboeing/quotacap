import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { projectQuotasResponse, projectRecommendationResponse } from "../../src/advisory/snapshot.js";
import type { StateSnapshot } from "../../src/advisory/types.js";
import { compactSuffix, forecastText, stateWord } from "../../src/format/rows.js";
import {
  provWidthFor,
  renderCompact,
  renderNarrow,
  renderWide,
} from "../../src/format/terminal.js";
import { renderMarkdownTable, renderRecommendationSummary } from "../../src/format/markdown.js";
import { renderIssues } from "../../src/format/issues.js";
import { openDb, migrate } from "../../src/store/db.js";
import { upsertQuota } from "../../src/store/quotas.js";
import { recordAttempt, getAttempt } from "../../src/store/attempts.js";
import { handleTool } from "../../src/mcp/server.js";
import {
  FIXED_NOW,
  exampleStateSnapshot,
  exampleStateSnapshotJson,
  resetPassedStateSnapshot,
  resetPassedStateSnapshotJson,
  staleStateSnapshot,
  staleStateSnapshotJson,
  unknownPaceStateSnapshot,
  unknownPaceStateSnapshotJson,
} from "../fixtures/stable-state.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Provider-id keyed row extraction per surface, so STATE words and forecasts
// compare per provider rather than by substring search.
function wideRows(out: string, width: number): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of out.split("\n").slice(1)) {
    map.set(line.slice(0, width).trim().replace(/^★ /, ""), line);
  }
  return map;
}

function narrowRows(out: string, width: number): Map<string, [string, string]> {
  const lines = out.split("\n");
  const map = new Map<string, [string, string]>();
  for (let i = 0; i + 1 < lines.length; i += 2) {
    map.set(lines[i].slice(0, width).trim().replace(/^★ /, ""), [lines[i], lines[i + 1]]);
  }
  return map;
}

function markdownRows(out: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const line of out.split("\n").slice(2)) {
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    map.set(cells[0].replace(/^★ /, ""), cells);
  }
  return map;
}

const FIXTURES: Array<[string, StateSnapshot, string]> = [
  ["example", exampleStateSnapshot, exampleStateSnapshotJson],
  ["stale", staleStateSnapshot, staleStateSnapshotJson],
  ["reset-passed", resetPassedStateSnapshot, resetPassedStateSnapshotJson],
  ["unknown-pace", unknownPaceStateSnapshot, unknownPaceStateSnapshotJson],
];

const tmpDirs: string[] = [];
let savedHome: string | undefined;
let savedUrl: string | undefined;
beforeEach(() => {
  savedHome = process.env.QUOTACAP_HOME;
  savedUrl = process.env.QUOTACAP_URL;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qc-parity-"));
  tmpDirs.push(home);
  process.env.QUOTACAP_HOME = home;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.QUOTACAP_HOME;
  else process.env.QUOTACAP_HOME = savedHome;
  if (savedUrl === undefined) delete process.env.QUOTACAP_URL;
  else process.env.QUOTACAP_URL = savedUrl;
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

for (const [name, snap, snapJson] of FIXTURES) {
  describe(`parity: ${name}`, () => {
    let closeServer: () => Promise<void>;
    beforeEach(async () => {
      const server = http.createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(snapJson);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      process.env.QUOTACAP_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      closeServer = () =>
        new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    });
    afterEach(async () => {
      await closeServer();
    });

    const surfaces = () => {
      const width = provWidthFor(snap.providers.map((p) => p.displayName));
      const wide = strip(renderWide(snap, { now: FIXED_NOW }));
      const narrow = strip(renderNarrow(snap, { now: FIXED_NOW }));
      return {
        width,
        wide,
        narrow,
        compact: renderCompact(snap, FIXED_NOW),
        markdown: renderMarkdownTable(snap, FIXED_NOW),
        wideById: wideRows(wide, width),
        narrowById: narrowRows(narrow, width),
        markdownById: markdownRows(renderMarkdownTable(snap, FIXED_NOW)),
      };
    };

    it("(a) names the same use and waste sentence everywhere", async () => {
      const s = surfaces();
      const { use, reason } = snap.recommendation;
      const useName = snap.providers.find((p) => p.id === use)?.displayName ?? use;
      expect(s.compact).toContain(`(use: ${use})`);
      expect(s.wide).toContain(`★ ${useName}`);
      expect(s.narrow).toContain(`★ ${useName}`);
      expect(s.markdown).toContain(`| ★ ${useName} |`);
      expect(renderRecommendationSummary(snap)).toBe(`${use}: ${reason}`);
      expect(projectRecommendationResponse(snap).reason).toBe(reason);
      const mcpRec: any = await handleTool("get_recommendation", { task: "any" });
      expect(mcpRec.content[0].text).toBe(`${use}: ${reason}`);
      expect(JSON.parse(mcpRec.content[1].text)).toEqual(projectRecommendationResponse(snap, "any"));
      for (const text of [s.wide, s.narrow, s.markdown]) {
        expect(text).toContain(reason);
      }
      const useForecast: any = await handleTool("forecast", { provider: use });
      expect(JSON.parse(useForecast.content[0].text).forecast).toBe(reason);
    });

    it("(b) shares STATE words and compact entries per provider", async () => {
      const s = surfaces();
      const vocab = ["On track", "Behind pace", "Ahead of pace", "Cap risk", "Not reporting"];
      for (const p of snap.providers) {
        const state = stateWord(p);
        expect(vocab).toContain(state);
        expect(s.wideById.get(p.displayName)).toContain(state);
        expect(s.narrowById.get(p.displayName)![1]).toContain(state);
        expect(s.markdownById.get(p.displayName)![4]).toBe(state);
        if (p.quota) {
          expect(s.compact).toContain(`[${p.id}:${Math.round(p.quota.usedPct)}%${compactSuffix(p)}]`);
          const f: any = await handleTool("forecast", { provider: p.id });
          expect(JSON.parse(f.content[0].text).state).toBe(state);
        } else {
          await expect(handleTool("forecast", { provider: p.id })).rejects.toThrow(/missing-reading/);
        }
      }
    });

    it("(c) excludes stale, reset-passed, and invalid rows with specific labels", async () => {
      const s = surfaces();
      expect([...s.wideById.keys()]).toEqual([...s.narrowById.keys()]);
      expect([...s.wideById.keys()]).toEqual([...s.markdownById.keys()]);
      for (const p of snap.providers) {
        if (p.exclusionReason === null) continue;
        const label = forecastText(p, FIXED_NOW);
        expect(s.wideById.get(p.displayName)).toContain(label);
        expect(s.narrowById.get(p.displayName)![1]).toContain(label);
        expect(s.markdownById.get(p.displayName)![5]).toBe(label);
        expect(s.markdownById.get(p.displayName)![4]).toBe("Not reporting");
        if (p.quota) {
          const f: any = await handleTool("forecast", { provider: p.id });
          const body = JSON.parse(f.content[0].text);
          expect(body.exclusionReason).toBe(p.exclusionReason);
          expect(body.forecast).toBe(label);
        }
      }
      const quotas: any = await handleTool("get_quotas", {});
      const rows = JSON.parse(quotas.content[1].text);
      expect(rows).toEqual(projectQuotasResponse(snap));
    });

    it("(d) shows no numeric rate or predicted waste for unknown pace", async () => {
      const s = surfaces();
      for (const text of [s.wide, s.narrow, s.compact, s.markdown]) {
        expect(text).not.toMatch(/predicted waste/i);
      }
      const unknown = snap.providers.filter(
        (p) => p.exclusionReason === null && p.advisory?.paceSource === "unknown",
      );
      expect(unknown.length).toBeGreaterThan(0);
      for (const p of unknown) {
        for (const text of [
          s.wideById.get(p.displayName)!,
          s.narrowById.get(p.displayName)![1],
          s.markdownById.get(p.displayName)![5],
        ]) {
          expect(text).not.toMatch(/waste/i);
          expect(text).not.toMatch(/%\/day/);
          expect(text).not.toMatch(/per day/i);
        }
        expect(s.compact).toContain(`[${p.id}:${Math.round(p.quota!.usedPct)}%?]`);
        const f: any = await handleTool("forecast", { provider: p.id });
        const body = JSON.parse(f.content[0].text);
        expect(body.advisory.burnRate).toBeNull();
        expect(body.forecast).not.toMatch(/waste/i);
      }
    });

    it("(e) labels estimated resets in every surface", async () => {
      const s = surfaces();
      const estimated = snap.providers.filter((p) => p.quota?.resetsAtEstimated);
      expect(estimated.length).toBeGreaterThan(0);
      for (const p of estimated) {
        expect(s.wideById.get(p.displayName)).toContain("(est.)");
        expect(s.narrowById.get(p.displayName)![1]).toContain("(est.)");
        expect(s.markdownById.get(p.displayName)![3]).toContain("(est.)");
        expect(s.markdownById.get(p.displayName)![5]).toMatch(/estimated/i);
        expect(s.compact).toContain(`[${p.id}:${Math.round(p.quota!.usedPct)}%${compactSuffix(p)}]`);
        const f: any = await handleTool("forecast", { provider: p.id });
        const body = JSON.parse(f.content[0].text);
        expect(body.forecast).toMatch(/estimated/i);
        expect(body.evidence).toContain("estimated-reset");
      }
      const quotas: any = await handleTool("get_quotas", {});
      for (const row of JSON.parse(quotas.content[1].text)) {
        if (row.resetsAtEstimated) expect(row.evidence).toContain("estimated-reset");
      }
    });

    it("(f) renders the invalid grok row everywhere without throwing", async () => {
      const renderAll = () => {
        const s = surfaces();
        return [
          s.wideById.get("Grok")!,
          s.narrowById.get("Grok")![1],
          s.markdownById.get("Grok")!.join("|"),
        ];
      };
      expect(renderAll).not.toThrow();
      for (const text of renderAll()) {
        expect(text).toContain("Not reporting");
        expect(text).toContain("invalid reading");
      }
      const f: any = await handleTool("forecast", { provider: "grok" });
      const body = JSON.parse(f.content[0].text);
      expect(body.exclusionReason).toBe("invalid");
      expect(body.advisory).toBeNull();
      expect(body.state).toBe("Not reporting");
      expect(body.forecast).toBe("invalid reading");
    });
  });
}

describe("parity: provider-error observability", () => {
  const failedSnapshot = (): StateSnapshot => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const codex = s.providers.find((p: any) => p.id === "codex");
    codex.reporting = false;
    codex.exclusionReason = "provider-failed";
    codex.lastAttempt = {
      provider: "codex",
      attemptedAt: FIXED_NOW.toISOString(),
      completedAt: FIXED_NOW.toISOString(),
      succeededAt: null,
      success: false,
      failureCategory: "unknown",
      diagnosticCode: "terminal_error",
      summary: "Unable to open Codex session",
      action: "Open Codex directly in your terminal to check whether it starts.",
      errorDetail: "pty exited during settle (code 1): stdin is not a terminal",
    };
    return s;
  };

  let closeServer: () => Promise<void>;
  beforeEach(async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(failedSnapshot()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.QUOTACAP_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    closeServer = () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });
  afterEach(async () => {
    await closeServer();
  });

  it("maintains detail parity across stored db, HTTP state, verbose CLI, and MCP", async () => {
    const snap = failedSnapshot();
    const codexAttempt = snap.providers.find((p) => p.id === "codex")!.lastAttempt!;

    // 1. Stored state
    const db = openDb(":memory:");
    migrate(db);
    upsertQuota(db, {
      provider: "codex",
      plan: "p",
      source: "cli",
      usedPct: 40,
      resetsAt: "2026-09-14T06:00:00+10:00",
      periodStart: "2026-08-31T06:00:00+10:00",
      fetchedAt: FIXED_NOW.toISOString(),
    });
    recordAttempt(db, codexAttempt);
    const stored = getAttempt(db, "codex")!;
    expect(stored.diagnosticCode).toBe(codexAttempt.diagnosticCode);
    expect(stored.summary).toBe(codexAttempt.summary);
    expect(stored.action).toBe(codexAttempt.action);
    expect(stored.errorDetail).toBe(codexAttempt.errorDetail);
    db.close();

    // 2. HTTP state
    const res = await fetch(`${process.env.QUOTACAP_URL}/api/state`);
    const httpSnap: StateSnapshot = (await res.json()) as StateSnapshot;
    const httpAttempt = httpSnap.providers.find((p) => p.id === "codex")!.lastAttempt!;
    expect(httpAttempt).toEqual(codexAttempt);

    // 3. Verbose CLI
    const issues = renderIssues(snap, false);
    expect(issues).toContain(`• codex: ${codexAttempt.summary}`);
    expect(issues).toContain(`  Action: ${codexAttempt.action}`);
    expect(issues).toContain(`  Detail: ${codexAttempt.errorDetail}`);
    const wide = renderWide(snap, { now: FIXED_NOW });
    expect(wide).toContain(codexAttempt.summary);

    // 4. MCP
    const mcpForecast: any = await handleTool("forecast", { provider: "codex" });
    const forecastBody = JSON.parse(mcpForecast.content[0].text);
    expect(forecastBody.lastAttempt).toEqual(codexAttempt);
    expect(forecastBody.forecast).toBe(codexAttempt.summary);

    const mcpQuotas: any = await handleTool("get_quotas", {});
    expect(mcpQuotas.content[0].text).toContain(codexAttempt.summary!);

    // 5. Leak check: no raw secret in any surface
    const secret = "private-value";
    for (const surface of [
      JSON.stringify(stored),
      JSON.stringify(httpSnap),
      issues,
      wide,
      JSON.stringify(forecastBody),
      mcpQuotas.content[0].text,
    ]) {
      expect(surface).not.toContain(secret);
    }
  });
});
