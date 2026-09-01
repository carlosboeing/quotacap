import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseKimiTui, kimiAdapter } from "../../src/adapters/kimi.js";
import { runPty, stripAnsi } from "../../src/adapters/pty.js";

function kimiFixture(overrides?: { weeklyPct?: number; weeklyReset?: string; fivePct?: number; fiveReset?: string; extra?: string }): string {
  const wPct = overrides?.weeklyPct ?? 7;
  const wReset = overrides?.weeklyReset ?? "in 6d 19h 57m";
  const fPct = overrides?.fivePct ?? 33;
  const fReset = overrides?.fiveReset ?? "in 57m";
  const extra = overrides?.extra ?? "";
  return `
  Welcome to Kimi Code
  context: 0% (0/1M)
  ╭ Usage ──────────────────────────╮
  │ Plan usage                      │
  │   Weekly limit  █░░░░  ${wPct}% used   resets ${wReset} │
  │   5h limit      ██░░  ${fPct}% used  resets ${fReset}        │
  ${extra}
  ╰─────────────────────────────────╯
  > `;
}

describe("parseKimiTui", () => {
  it("maps weekly 7% and 5h 33% with relative resets", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const txt = kimiFixture();
    const q = parseKimiTui(txt, now);
    expect(q.provider).toBe("kimi");
    expect(q.usedPct).toBe(7);
    expect(q.sessionPct).toBe(33);
    expect(q.plan).toBe("unknown");
    // source is tui (cast)
    expect((q as unknown as { source: string }).source).toBe("tui");
    expect(Number.isNaN(new Date(q.resetsAt).getTime())).toBe(false);
    expect(Number.isNaN(new Date(q.periodStart).getTime())).toBe(false);
    expect(new Date(q.periodStart).getTime()).toBe(new Date(q.resetsAt).getTime() - 7 * 86400000);
    // weekly reset should be ~6d 19h 57m after now
    const diff = new Date(q.resetsAt).getTime() - now.getTime();
    expect(diff).toBeGreaterThan(6 * 86400000);
    expect(diff).toBeLessThan(7 * 86400000);
    expect(q.fetchedAt).toBe(now.toISOString());
  });

  it("strips ANSI before parsing", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const txt = `\x1b[31mWelcome to Kimi Code\x1b[0m\ncontext: 0% (0/1M)\nWeekly limit  \x1b[38;5;244m█\x1b[0m 12% used   resets in 2d 1h 5m\n5h limit      45% used  resets in 1h 10m\n`;
    const q = parseKimiTui(txt, now);
    expect(q.usedPct).toBe(12);
    expect(q.sessionPct).toBe(45);
  });

  it("parses with bar characters and unicode box drawing", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const raw = stripAnsi(kimiFixture({ weeklyPct: 7, fivePct: 33 }));
    expect(raw).toMatch(/Weekly limit/);
    const q = parseKimiTui(kimiFixture({ weeklyPct: 7, fivePct: 33 }), now);
    expect(q.usedPct).toBe(7);
  });

  it("throws when weekly limit is absent (fail-closed)", () => {
    const txt = `5h limit      33% used  resets in 57m\n`;
    expect(() => parseKimiTui(txt, new Date())).toThrow(/weekly limit/i);
  });

  it("throws when 5h limit is absent (fail-closed)", () => {
    const txt = `Weekly limit  7% used   resets in 6d 19h 57m\n`;
    expect(() => parseKimiTui(txt, new Date())).toThrow(/5h limit/i);
  });

  it("throws when reset duration is malformed (fail-closed)", () => {
    const txt = kimiFixture({ weeklyReset: "in ???", fiveReset: "in 57m" });
    expect(() => parseKimiTui(txt, new Date())).toThrow(/bad weekly reset/i);
  });

  it("takes plan from Weekly limit (Tier) when present", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const txt = kimiFixture({ extra: "" }) + "\nWeekly limit (Pro)  7% used resets in 6d 19h 57m\n5h limit 33% used resets in 57m";
    // inject paren into first line via replacement: we already have generic, override with custom text
    const custom = `Welcome to Kimi Code\nWeekly limit (Pro)  █ 7% used   resets in 6d 19h 57m\n5h limit      33% used  resets in 57m\n`;
    const q = parseKimiTui(custom, now);
    expect(q.plan).toBe("pro");
  });

  it("raw is capped and contains cleaned transcript", () => {
    const q = parseKimiTui(kimiFixture(), new Date());
    expect(q.raw.length).toBeGreaterThan(0);
    expect(q.raw.length).toBeLessThanOrEqual(4096);
    expect(q.raw).toMatch(/Weekly limit/);
  });
});

describe("kimi TUI via fake PTY", () => {
  async function writeFake(content: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qc-kimi-fake-"));
    const file = path.join(dir, "fake.mjs");
    await fs.writeFile(file, content, { mode: 0o755 });
    return file;
  }

  it("happy-path: fake TUI yields correct Quota via runPty + parse", async () => {
    const script = `
process.stdout.write('Welcome to Kimi Code\\n');
process.stdout.write('context: 0% (0/1M)\\n');
let buf='';
process.stdin.on('data', d=>{
  buf+=d.toString();
  if(buf.includes('/usage')){
    setTimeout(()=>{
      process.stdout.write('Weekly limit  \\u2588\\u2591  7% used   resets in 6d 19h 57m\\n');
      process.stdout.write('5h limit      \\u2588\\u2588 33% used  resets in 57m\\n');
    },30);
  }
});
setInterval(()=>{},1000);
`;
    const fake = await writeFake(script);
    const transcript = await runPty({
      file: process.execPath,
      args: [fake],
      readyRegex: /Welcome to Kimi Code|context:/i,
      readyTimeoutMs: 2000,
      input: "/usage\r",
      completionRegex: /Weekly limit[\s\S]*5h limit/,
      timeoutMs: 2000,
      maxBytes: 64 * 1024,
    });
    const q = parseKimiTui(transcript, new Date("2026-09-01T00:00:00Z"));
    expect(q.usedPct).toBe(7);
    expect(q.sessionPct).toBe(33);
    expect(q.provider).toBe("kimi");
  });

  it("timeout → rejected when fake never emits completion", async () => {
    const script = `
process.stdout.write('Welcome to Kimi Code\\n');
process.stdin.on('data', ()=>{});
setInterval(()=>{},1000);
`;
    const fake = await writeFake(script);
    await expect(
      runPty({
        file: process.execPath,
        args: [fake],
        readyRegex: /Welcome to Kimi Code/,
        readyTimeoutMs: 2000,
        input: "/usage\r",
        completionRegex: /Weekly limit/,
        timeoutMs: 600,
      }),
    ).rejects.toThrow(/completion timeout/i);
  });

  it("malformed text → parse rejects (fail-closed, no partial Quota)", async () => {
    const script = `
process.stdout.write('Welcome to Kimi Code\\n');
let buf='';
process.stdin.on('data', d=>{
  buf+=d.toString();
  if(buf.includes('/usage')){
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
      readyRegex: /Welcome to Kimi Code/,
      readyTimeoutMs: 2000,
      input: "/usage\r",
      completionRegex: /Weekly limit/,
      timeoutMs: 2000,
    });
    expect(() => parseKimiTui(transcript)).toThrow();
  });

  it("clean kill: fake process does not survive after runPty", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qc-kimi-pid-"));
    const pidFile = path.join(dir, "pid");
    const script = `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdout.write('Welcome to Kimi Code\\n');
let buf='';
process.stdin.on('data', d=>{
  buf+=d.toString();
  if(buf.includes('/usage')){
    setTimeout(()=>{
      process.stdout.write('Weekly limit  7% used   resets in 6d 19h 57m\\n');
      process.stdout.write('5h limit      33% used  resets in 57m\\n');
    },30);
  }
});
setInterval(()=>{},1000);
`;
    const fake = await writeFake(script);
    const transcript = await runPty({
      file: process.execPath,
      args: [fake],
      readyRegex: /Welcome to Kimi Code/,
      readyTimeoutMs: 2000,
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
});

describe("kimiAdapter live poll", () => {
  it.skipIf(!process.env.QUOTACAP_LIVE_TUI)("polls live kimi TUI and returns correct Quota", async () => {
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("which", ["kimi"], { stdio: "ignore", timeout: 2000 });
    } catch {
      console.warn("live kimi poll skipped: kimi not on PATH");
      return;
    }
    const q = await kimiAdapter.poll();
    expect(q.provider).toBe("kimi");
    expect((q as unknown as { source: string }).source).toBe("tui");
    expect(q.usedPct).toBeGreaterThanOrEqual(0);
    expect(q.usedPct).toBeLessThanOrEqual(100);
    if (q.sessionPct !== undefined) {
      expect(q.sessionPct).toBeGreaterThanOrEqual(0);
      expect(q.sessionPct).toBeLessThanOrEqual(100);
    }
    expect(Number.isNaN(new Date(q.resetsAt).getTime())).toBe(false);
    expect(Number.isNaN(new Date(q.periodStart).getTime())).toBe(false);
    expect(q.raw.length).toBeGreaterThan(0);
    expect(q.fetchedAt).toBeDefined();
  }, 15000);
});
