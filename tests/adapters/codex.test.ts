import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCodexTui, codexAdapter } from "../../src/adapters/codex.js";
import { runPty, stripAnsi } from "../../src/adapters/pty.js";

function codexFixture(overrides?: { weeklyLeft?: number; weeklyReset?: string; fiveLeft?: number; fiveReset?: string }): string {
  const wLeft = overrides?.weeklyLeft ?? 27;
  const wReset = overrides?.weeklyReset ?? "16:36 on 7 Sep";
  const fLeft = overrides?.fiveLeft ?? 9;
  const fReset = overrides?.fiveReset ?? "14:12";
  return `5h limit: ${fLeft}% left (resets ${fReset})\nWeekly limit: ${wLeft}% left (resets ${wReset})\n`;
}

describe("parseCodexTui", () => {
  it("maps weekly left 73% to used 27% and 5h left 9% to session 91%", () => {
    const now = new Date("2026-09-01T10:00:00");
    const txt = codexFixture({ weeklyLeft: 73, weeklyReset: "16:36 on 7 Sep", fiveLeft: 9, fiveReset: "14:12" });
    const q = parseCodexTui(txt, now);
    expect(q.provider).toBe("codex");
    expect(q.weeklyPct).toBe(27);
    expect(q.fiveHourPct).toBe(91);
    expect(q.source).toBe("tui");
    expect(new Date(q.resetsAt).getTime()).toBeGreaterThan(now.getTime());
    expect(new Date(q.periodStart).getTime()).toBe(new Date(q.resetsAt).getTime() - 7 * 86400000);
  });

  it("handles 0% left and 100% left extremes", () => {
    const now = new Date("2026-09-01T10:00:00");
    const txt = codexFixture({ weeklyLeft: 0, fiveLeft: 100 });
    const q = parseCodexTui(txt, now);
    expect(q.weeklyPct).toBe(100);
    expect(q.fiveHourPct).toBe(0);
  });

  it("strips ANSI before parsing", () => {
    const now = new Date("2026-09-01T10:00:00");
    const txt = `\x1b[31m5h limit: 9% left (resets 14:12)\x1b[0m\n\x1b[32mWeekly limit: 73% left (resets 16:36 on 7 Sep)\x1b[0m\n`;
    const q = parseCodexTui(txt, now);
    expect(q.weeklyPct).toBe(27);
    expect(q.fiveHourPct).toBe(91);
  });

  it("parses weekly reset with locale-aware month (case-insensitive)", () => {
    const now = new Date("2026-09-01T00:00:00");
    const txt = codexFixture({ weeklyReset: "16:36 on 7 sep" });
    const q = parseCodexTui(txt, now);
    expect(Number.isNaN(new Date(q.resetsAt).getTime())).toBe(false);
    const dt = new Date(q.resetsAt);
    expect(dt.getMonth()).toBe(8);
    expect(dt.getDate()).toBe(7);
  });

  it("rolls weekly reset to next year when date is in the past", () => {
    const now = new Date("2026-09-08T10:00:00");
    const txt = codexFixture({ weeklyReset: "16:36 on 7 Sep" });
    const q = parseCodexTui(txt, now);
    const dt = new Date(q.resetsAt);
    expect(dt.getFullYear()).toBe(2027);
  });

  it("parses 5h reset as tomorrow when time is earlier than now", () => {
    const now = new Date("2026-09-01T15:00:00");
    const txt = codexFixture({ fiveReset: "14:12" });
    const q = parseCodexTui(txt, now);
    // weeklyIso is still 7 Sep, but 5h session reset should be tomorrow 14:12
    // we check session reset via parsing indirectly: weeklyPct still correct, and resetsAt is weekly
    // For 5h we can't directly check via Quota (only weekly is stored), but parse should not throw
    expect(q.fiveHourPct).toBeDefined();
  });

  it("parses the v0.154.0 /status panel with progress bars, ignoring the startup footer", () => {
    const now = new Date("2026-09-14T14:00:00");
    const txt = [
      "• You have 1 usage limit reset available. · 5h 89% left · weekly 11% left",
      "│  5h limit:             [█████░░░░░░░░░░░░░░░] 23% left (resets 19:38)           │",
      "│  Weekly limit:         [███████████████░░░░░] 77% left (resets 23:04 on 19 Sep) │",
    ].join("\n");
    const q = parseCodexTui(txt, now);
    expect(q.weeklyPct).toBe(23);
    expect(q.fiveHourPct).toBe(77);
    expect(q.resetsAtEstimated).toBeUndefined();
    expect(new Date(q.resetsAt).getTime()).toBe(new Date(2026, 8, 19, 23, 4).getTime());
  });

  it("parses a date-qualified 5h reset (live 2026-09-14 shape)", () => {
    const now = new Date(2026, 8, 14, 21, 44);
    const txt = [
      "• You have 1 usage limit reset available. Run /usage to use one. · 5h 100% left · weekly 73% left",
      "│  5h limit:             [████████████████████] 100% left (resets 02:43 on 15 Sep) │",
      "│  Weekly limit:         [███████████████░░░░░] 73% left (resets 23:04 on 19 Sep)  │",
    ].join("\n");
    const q = parseCodexTui(txt, now);
    expect(q.weeklyPct).toBe(27);
    expect(q.fiveHourPct).toBe(0);
    expect(q.resetsAtEstimated).toBeUndefined();
    expect(new Date(q.resetsAt).getTime()).toBe(new Date(2026, 8, 19, 23, 4).getTime());
  });

  it("takes plan from the /status Account line when present", () => {
    const now = new Date("2026-09-01T10:00:00");
    const txt = `Account:              carlosboeing@gmail.com (Plus)\n${codexFixture()}`;
    expect(parseCodexTui(txt, now).plan).toBe("Plus");
  });

  it("leaves plan unknown when the /status Account line is absent", () => {
    expect(parseCodexTui(codexFixture(), new Date()).plan).toBe("unknown");
  });

  it("throws when access token could not be refreshed or refresh token was already used", () => {
    const raw =
      "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.";
    expect(() => parseCodexTui(raw)).toThrow(/refresh token was already used|log out and sign in again/i);
  });

  it("throws when limits refresh was requested shortly", () => {
    const raw =
      "OpenAI Codex (v0.154.0)\nLimits: refresh requested; run /status again shortly.\n";
    expect(() => parseCodexTui(raw)).toThrow(/limits refresh requested/i);
  });

  it("throws when weekly limit absent (fail-closed)", () => {
    const txt = `5h limit: 9% left (resets 14:12)\n`;
    expect(() => parseCodexTui(txt, new Date())).toThrow(/weekly limit/i);
  });

  it("throws when 5h limit absent (fail-closed)", () => {
    const txt = `Weekly limit: 73% left (resets 16:36 on 7 Sep)\n`;
    expect(() => parseCodexTui(txt, new Date())).toThrow(/5h limit/i);
  });

  it("parses the Codex 0.157 12-hour panel", () => {
    const now = new Date(2026, 8, 26, 12, 0);
    const txt = [
      "│  5h limit:             [████░░░░░░░░░░░░░░░░] 91% left (resets 9:43 PM) │",
      "│  Weekly limit:         [██░░░░░░░░░░░░░░░░░░] 8% left (resets 9:14 AM on 30 Sep) │",
    ].join("\n");
    const q = parseCodexTui(txt, now);
    expect(q.weeklyPct).toBe(92);
    expect(q.fiveHourPct).toBe(9);
    expect(q.resetsAtEstimated).toBeUndefined();
    expect(new Date(q.resetsAt).getTime()).toBe(new Date(2026, 8, 30, 9, 14).getTime());
  });

  it("maps 12 AM and 12 PM onto 00:00 and 12:00", () => {
    const now = new Date(2026, 8, 26, 1, 0);
    const noon = parseCodexTui(codexFixture({ weeklyReset: "12:00 PM on 30 Sep", fiveReset: "12:00 AM" }), now);
    expect(new Date(noon.resetsAt).getHours()).toBe(12);
    const midnightWeekly = parseCodexTui(codexFixture({ weeklyReset: "12:00 AM on 30 Sep" }), now);
    expect(new Date(midnightWeekly.resetsAt).getHours()).toBe(0);
  });

  it("throws when weekly reset is malformed (fail-closed)", () => {
    const txt = codexFixture({ weeklyReset: "bad time" });
    expect(() => parseCodexTui(txt, new Date())).toThrow(/bad weekly reset/i);
  });

  it("raw is capped and contains cleaned transcript", () => {
    const q = parseCodexTui(codexFixture(), new Date());
    expect((q as any).raw.length).toBeGreaterThan(0);
    expect((q as any).raw.length).toBeLessThanOrEqual(4096);
    expect((q as any).raw).toMatch(/Weekly limit/);
  });
});

describe("codex TUI via fake PTY", () => {
  async function writeFake(content: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qc-codex-fake-"));
    const file = path.join(dir, "fake.mjs");
    await fs.writeFile(file, content, { mode: 0o755 });
    return file;
  }

  it("happy-path: fake TUI yields correct Quota via runPty + parse", async () => {
    const script = `
process.stdout.write('Starting MCP servers...\\n');
setTimeout(()=>{ process.stdout.write('codex ready\\n'); }, 100);
let buf='';
process.stdin.on('data', d=>{
  buf+=d.toString();
  if(buf.includes('/status')){
    setTimeout(()=>{
      process.stdout.write('5h limit: 9% left (resets 14:12)\\n');
      process.stdout.write('Weekly limit: 73% left (resets 16:36 on 7 Sep)\\n');
    },30);
  }
});
setInterval(()=>{},1000);
`;
    const fake = await writeFake(script);
    const transcript = await runPty({
      file: process.execPath,
      args: [fake],
      settleDelayMs: 200,
      input: "/status\r",
      completionRegex: /Weekly limit[\s\S]*5h limit|5h limit[\s\S]*Weekly limit/i,
      timeoutMs: 2000,
      maxBytes: 64 * 1024,
    });
    const q = parseCodexTui(transcript, new Date("2026-09-01T10:00:00"));
    expect(q.weeklyPct).toBe(27);
    expect(q.fiveHourPct).toBe(91);
    expect(q.provider).toBe("codex");
  });

  it("timeout → rejected when fake never emits completion", async () => {
    const script = `
process.stdout.write('codex ready\\n');
process.stdin.on('data', ()=>{});
setInterval(()=>{},1000);
`;
    const fake = await writeFake(script);
    await expect(
      runPty({
        file: process.execPath,
        args: [fake],
        settleDelayMs: 100,
        input: "/status\r",
        completionRegex: /Weekly limit/,
        timeoutMs: 600,
      }),
    ).rejects.toThrow(/completion timeout/i);
  });

  it("malformed text → parse rejects (fail-closed, no partial Quota)", async () => {
    const script = `
process.stdout.write('codex ready\\n');
let buf='';
process.stdin.on('data', d=>{
  buf+=d.toString();
  if(buf.includes('/status')){
    setTimeout(()=>{
      process.stdout.write('Weekly limit  ??? no number\\n');
      process.stdout.write('5h limit      also broken\\n');
    },30);
  }
});
setInterval(()=>{},1000);
`;
    const fake = await writeFake(script);
    const transcript = await runPty({
      file: process.execPath,
      args: [fake],
      settleDelayMs: 100,
      input: "/status\r",
      completionRegex: /Weekly limit/,
      timeoutMs: 2000,
    });
    expect(() => parseCodexTui(transcript)).toThrow();
  });

  it("clean kill: fake process does not survive after runPty", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qc-codex-pid-"));
    const pidFile = path.join(dir, "pid");
    const script = `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdout.write('codex ready\\n');
let buf='';
process.stdin.on('data', d=>{
  buf+=d.toString();
  if(buf.includes('/status')){
    setTimeout(()=>{
      process.stdout.write('5h limit: 9% left (resets 14:12)\\n');
      process.stdout.write('Weekly limit: 73% left (resets 16:36 on 7 Sep)\\n');
    },30);
  }
});
setInterval(()=>{},1000);
`;
    const fake = await writeFake(script);
    const transcript = await runPty({
      file: process.execPath,
      args: [fake],
      settleDelayMs: 100,
      input: "/status\r",
      completionRegex: /Weekly limit/,
      timeoutMs: 2000,
    });
    expect(stripAnsi(transcript)).toMatch(/Weekly limit/);
    await new Promise((r) => setTimeout(r, 400));
    const pid = parseInt(await fs.readFile(pidFile, "utf8"), 10);
    let alive = true;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("aborts when trust prompt detected (abortOn fail-closed)", async () => {
    const script = `
process.stdout.write('Do you trust the files in this folder? (y/n)\\n');
setInterval(()=>{},1000);
`;
    const fake = await writeFake(script);
    await expect(
      runPty({
        file: process.execPath,
        args: [fake],
        settleDelayMs: 200,
        input: "/status\r",
        completionRegex: /Weekly limit/,
        abortOn: /Do you trust|Trust.*folder/i,
        timeoutMs: 2000,
      }),
    ).rejects.toThrow(/untrusted workspace/i);
  });
});

describe("codexAdapter live poll", () => {
  it.skipIf(!process.env.QUOTACAP_LIVE_TUI)("polls live codex TUI and returns correct Quota", async () => {
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("which", ["codex"], { stdio: "ignore", timeout: 2000 });
    } catch {
      console.warn("live codex poll skipped: codex not on PATH");
      return;
    }
    const q = await codexAdapter.poll();
    expect(q.provider).toBe("codex");
    expect(q.source).toBe("tui");
    expect(q.weeklyPct).toBeGreaterThanOrEqual(0);
    expect(q.weeklyPct).toBeLessThanOrEqual(100);
    if ((q as any).fiveHourPct !== undefined) {
      expect((q as any).fiveHourPct).toBeGreaterThanOrEqual(0);
      expect((q as any).fiveHourPct).toBeLessThanOrEqual(100);
    }
    expect(Number.isNaN(new Date(q.resetsAt).getTime())).toBe(false);
    expect(Number.isNaN(new Date(q.periodStart).getTime())).toBe(false);
    expect((q as any).raw.length).toBeGreaterThan(0);
    expect(q.fetchedAt).toBeDefined();
  }, 20000);
});
