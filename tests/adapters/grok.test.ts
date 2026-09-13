import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseGrokTui, grokAdapter } from "../../src/adapters/grok.js";
import { runPty, stripAnsi } from "../../src/adapters/pty.js";
import { classifyFailure } from "../../src/diagnostics/failure.js";
import { buildApp, testCtx } from "../../src/http/server.js";
import { openDb, migrate } from "../../src/store/db.js";
import { upsertQuota } from "../../src/store/quotas.js";

function grokFixture(overrides?: { plan?: string; usedPct?: number; credits?: string; reset?: string; extra?: string }): string {
  const plan = overrides?.plan ?? "SuperGrok";
  const pct = overrides?.usedPct ?? 26;
  const cred = overrides?.credits ?? "Credits: $4.85";
  const reset = overrides?.reset ?? "Resets: September 7, 10:22";
  const extra = overrides?.extra ?? "";
  return `
  ┌ Usage limit ──────────────────────────┐
  │ Weekly limit (${plan})  ███  ${pct}% │
  │ ${cred}                             │
  │ ${reset}                             │
  │ Context: 1.5K / 500K                  │
  ${extra}
  └──────────────────────────────────────┘
  `;
}

describe("parseGrokTui", () => {
  it("maps weekly percent and credits and reset with plan tier", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const txt = grokFixture({ plan: "SuperGrok", usedPct: 26, credits: "Credits: $4.85", reset: "Resets: September 7, 10:22" });
    const q = parseGrokTui(txt, now);
    expect(q.provider).toBe("grok");
    expect(q.plan).toBe("SuperGrok");
    expect(q.usedPct).toBe(26);
    expect(q.creditsUsd).toBe(4.85);
    expect(q.source).toBe("tui");
    const dt = new Date(q.resetsAt);
    expect(dt.getMonth()).toBe(8);
    expect(dt.getDate()).toBe(7);
    expect(dt.getHours() === 10 || dt.getUTCHours() === 10).toBe(true);
    expect(Number.isNaN(new Date(q.periodStart).getTime())).toBe(false);
    expect(new Date(q.periodStart).getTime()).toBe(new Date(q.resetsAt).getTime() - 7 * 86400000);
  });

  it("parses SuperGrok Heavy tier with parens", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const txt = grokFixture({ plan: "SuperGrok Heavy", usedPct: 100 });
    const q = parseGrokTui(txt, now);
    expect(q.plan).toBe("SuperGrok Heavy");
    expect(q.usedPct).toBe(100);
  });

  it("strips ANSI before parsing", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const txt = `\x1b[31mWeekly limit (SuperGrok)\x1b[0m  \x1b[38;5;244m█\x1b[0m 42% \nCredits: $1.23\nResets: September 7, 10:22\n`;
    const q = parseGrokTui(txt, now);
    expect(q.usedPct).toBe(42);
    expect(q.creditsUsd).toBe(1.23);
  });

  it("hands creditsUsd undefined when Credits line absent", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const txt = `
      Weekly limit (SuperGrok)  50%
      Resets: September 7, 10:22
    `;
    const q = parseGrokTui(txt, now);
    expect(q.usedPct).toBe(50);
    expect(q.creditsUsd).toBeUndefined();
  });

  it("parses reset as future (next year if in past)", () => {
    const now = new Date("2026-09-08T11:00:00Z");
    const txt = grokFixture({ reset: "Resets: September 7, 10:22" });
    const q = parseGrokTui(txt, now);
    const dt = new Date(q.resetsAt);
    expect(dt.getFullYear()).toBe(2027);
  });

  it("parses the no-space reset form (September 14,10:22)", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const txt = grokFixture({ reset: "Resets: September 14,10:22" });
    const q = parseGrokTui(txt, now);
    const dt = new Date(q.resetsAt);
    expect(dt.getMonth()).toBe(8);
    expect(dt.getDate()).toBe(14);
    expect(dt.getHours() === 10 || dt.getUTCHours() === 10).toBe(true);
    expect(q.resetsAtEstimated).toBeUndefined();
  });

  it("throws when weekly limit absent (fail-closed)", () => {
    const txt = `Credits: $4.85\nResets: September 7, 10:22\n`;
    expect(() => parseGrokTui(txt, new Date())).toThrow(/weekly percent|weekly limit/i);
  });

  it("falls back to future reset when resets timestamp absent", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const txt = `Weekly limit (SuperGrok)  26%\nCredits: $4.85\n`;
    const q = parseGrokTui(txt, now);
    expect(q.provider).toBe("grok");
    expect(new Date(q.resetsAt).getTime()).toBeGreaterThan(now.getTime());
  });

  it("throws when resets timestamp malformed", () => {
    const txt = grokFixture({ reset: "Resets: bad date" });
    expect(() => parseGrokTui(txt, new Date())).toThrow(/resets/i);
  });

  it("throws bad resets timestamp for genuinely invalid reset forms and classifies as parse_error", () => {
    const invalidForms = ["Resets: September 99,99:99", "Resets: someday-ish"];
    for (const reset of invalidForms) {
      const txt = grokFixture({ reset });
      let thrown: any = null;
      try {
        parseGrokTui(txt, new Date());
      } catch (e) {
        thrown = e;
      }
      expect(thrown).not.toBeNull();
      expect(thrown.message).toMatch(/bad resets timestamp/i);
      const classified = classifyFailure("grok", thrown);
      expect(classified.diagnosticCode).toBe("parse_error");
      expect(classified.category).toBe("parse");
      expect(classified.summary).toBe("Unable to read Grok usage");
    }
  });

  it("raw is capped and contains cleaned transcript", () => {
    const q = parseGrokTui(grokFixture(), new Date());
    expect((q as any).raw.length).toBeGreaterThan(0);
    expect((q as any).raw.length).toBeLessThanOrEqual(4096);
    expect((q as any).raw).toMatch(/Weekly limit/);
  });

  // Live-transcript format (grok 1.0.30): the startup status line reports
  // REMAINING quota ("Weekly limit left: 0%"), while the /usage dialog
  // header reads "Weekly limt" (cursor reposition drops the "i") with the
  // used percent on the next line. The dialog wins; the status line must
  // never be read as used.
  function liveFixture(overrides?: { left?: string; header?: string; pct?: number; reset?: string }): string {
    const left = overrides?.left ?? "Weekly limit left: 0%";
    const header = overrides?.header ?? "Weekly limt (SuperGrok)";
    const pct = overrides?.pct ?? 100;
    const reset = overrides?.reset ?? "Resets:September 14, 10:22";
    return `Start Grok in a fresh worktree somewhere. ${left} · more text here\n` +
      `│  ${header}  │\n` +
      `│  ██████████████████████████████  ${pct}%  │\n` +
      `│  ${reset}  │\n` +
      `│  Loading session usage…  │\n`;
  }

  it("prefers the dialog used percent over the 'left' status line", () => {
    const now = new Date("2026-09-13T00:00:00Z");
    const q = parseGrokTui(liveFixture(), now);
    expect(q.usedPct).toBe(100);
    expect(q.plan).toBe("SuperGrok");
    const dt = new Date(q.resetsAt);
    expect(dt.getMonth()).toBe(8);
    expect(dt.getDate()).toBe(14);
  });

  it("ignores a disagreeing 'left' line when the dialog disagrees", () => {
    const now = new Date("2026-09-13T00:00:00Z");
    const txt = liveFixture({ left: "Weekly limit left: 74%", header: "Weekly limit (SuperGrok)", pct: 26 });
    const q = parseGrokTui(txt, now);
    expect(q.usedPct).toBe(26);
  });

  it("converts a lone 'left' line from remaining to used", () => {
    const now = new Date("2026-09-13T00:00:00Z");
    const txt = `Welcome. Weekly limit left: 30% · quota\nResets: September 14, 10:22\n`;
    const q = parseGrokTui(txt, now);
    expect(q.usedPct).toBe(70);
    expect(q.plan).toBe("unknown");
  });

  it("captures the full tier from a 'limt' header", () => {
    const now = new Date("2026-09-13T00:00:00Z");
    const txt = liveFixture({ header: "Weekly limt (SuperGrok Heavy)", pct: 55 });
    const q = parseGrokTui(txt, now);
    expect(q.plan).toBe("SuperGrok Heavy");
    expect(q.usedPct).toBe(55);
  });

  it("parses the raw cursor-repositioned header after ANSI stripping", () => {
    const now = new Date("2026-09-13T00:00:00Z");
    const txt = "Weekly limit left: 0%\nWeekly lim\x1b[14;39Ht (SuperGrok)\n████████████  100%\nResets:September 14, 10:22\n";
    const q = parseGrokTui(txt, now);
    expect(q.plan).toBe("SuperGrok");
    expect(q.usedPct).toBe(100);
  });

  it("later renders supersede earlier ones", () => {
    const now = new Date("2026-09-13T00:00:00Z");
    const txt = liveFixture({ pct: 26, reset: "Resets: September 7, 10:22" }) +
      liveFixture({ pct: 100, reset: "Resets: September 14, 10:22" });
    const q = parseGrokTui(txt, now);
    expect(q.usedPct).toBe(100);
    expect(new Date(q.resetsAt).getDate()).toBe(14);
  });
});

describe("grok TUI via fake PTY", () => {
  async function writeFake(content: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qc-grok-fake-"));
    const file = path.join(dir, "fake.mjs");
    await fs.writeFile(file, content, { mode: 0o755 });
    return file;
  }

  it("happy-path: fake TUI yields correct Quota via runPty + parse", async () => {
    const script = `
process.stdout.write('grok loading plugins...\\n');
setTimeout(()=>{ process.stdout.write('grok ready >\\n'); }, 100);
let buf='';
process.stdin.on('data', d=>{
  buf+=d.toString();
  if(buf.includes('/usage')){
    setTimeout(()=>{
      process.stdout.write('Weekly limit (SuperGrok)  █ 26%\\n');
      process.stdout.write('Credits: $4.85\\n');
      process.stdout.write('Resets: September 7, 10:22\\n');
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
      input: "/usage\r",
      completionRegex: /Weekly limit[\s\S]*Resets:|Resets:[\s\S]*Weekly limit/i,
      timeoutMs: 2000,
      maxBytes: 64 * 1024,
    });
    const q = parseGrokTui(transcript, new Date("2026-09-01T00:00:00Z"));
    expect(q.usedPct).toBe(26);
    expect(q.creditsUsd).toBe(4.85);
    expect(q.plan).toBe("SuperGrok");
    expect(q.provider).toBe("grok");
  });

  it("timeout → rejected when fake never emits completion", async () => {
    const script = `
process.stdout.write('grok ready\\n');
process.stdin.on('data', ()=>{});
setInterval(()=>{},1000);
`;
    const fake = await writeFake(script);
    await expect(
      runPty({
        file: process.execPath,
        args: [fake],
        settleDelayMs: 100,
        input: "/usage\r",
        completionRegex: /Weekly limit/,
        timeoutMs: 600,
      }),
    ).rejects.toThrow(/completion timeout/i);
  });

  it("malformed text → parse rejects (fail-closed, no partial Quota)", async () => {
    const script = `
process.stdout.write('grok ready\\n');
let buf='';
process.stdin.on('data', d=>{
  buf+=d.toString();
  if(buf.includes('/usage')){
    setTimeout(()=>{
      process.stdout.write('Weekly limit ??? broken\\n');
      process.stdout.write('Credits: ???\\n');
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
      input: "/usage\r",
      completionRegex: /Weekly limit/,
      timeoutMs: 2000,
    });
    expect(() => parseGrokTui(transcript)).toThrow();
  });

  it("clean kill: fake process does not survive after runPty", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qc-grok-pid-"));
    const pidFile = path.join(dir, "pid");
    const script = `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdout.write('grok ready\\n');
let buf='';
process.stdin.on('data', d=>{
  buf+=d.toString();
  if(buf.includes('/usage')){
    setTimeout(()=>{
      process.stdout.write('Weekly limit (SuperGrok)  26%\\n');
      process.stdout.write('Credits: $4.85\\n');
      process.stdout.write('Resets: September 7, 10:22\\n');
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
      input: "/usage\r",
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

  it("creditsUsd round-trips through store and /api/quotas", async () => {
    const db = openDb(":memory:"); migrate(db);
    const now = new Date("2026-09-01T00:00:00Z");
    const txt = grokFixture({ usedPct: 26, reset: "Resets: September 7, 10:22" });
    const q = parseGrokTui(txt, now);
    upsertQuota(db, q);
    const app = buildApp(testCtx(db));
    const res = await app.inject({ method: "GET", url: "/api/quotas" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body[0].creditsUsd).toBe(4.85);
    expect(body[0].usedPct).toBe(26);
    expect(body[0].raw).toBeUndefined();
  });
});

describe("grokAdapter live poll", () => {
  it.skipIf(!process.env.QUOTACAP_LIVE_TUI)("polls live grok TUI and returns correct Quota", async () => {
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("which", ["grok"], { stdio: "ignore", timeout: 2000 });
    } catch {
      console.warn("live grok poll skipped: grok not on PATH");
      return;
    }
    const q = await grokAdapter.poll();
    expect(q.provider).toBe("grok");
    expect(q.source).toBe("tui");
    expect(q.usedPct).toBeGreaterThanOrEqual(0);
    expect(q.usedPct).toBeLessThanOrEqual(100);
    expect(Number.isNaN(new Date(q.resetsAt).getTime())).toBe(false);
    expect(Number.isNaN(new Date(q.periodStart).getTime())).toBe(false);
    expect((q as any).raw.length).toBeGreaterThan(0);
    expect(q.fetchedAt).toBeDefined();
    if ((q as any).creditsUsd !== undefined) {
      expect(typeof (q as any).creditsUsd).toBe("number");
    }
  }, 25000);
});
