import { describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPty, stripAnsi, createTerminalQueryResponder } from "../../src/adapters/pty.js";
import * as ptyMod from "../../src/adapters/pty.js";
import { liveChildCount } from "../../src/runtime/spawn.js";
import { codexAdapter } from "../../src/adapters/codex.js";
import { kimiAdapter } from "../../src/adapters/kimi.js";
import { grokAdapter } from "../../src/adapters/grok.js";

function tmpFile(suffix = ".mjs"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "qc-pty-")).then((dir) => path.join(dir, `fake${suffix}`));
}

async function writeFake(content: string): Promise<string> {
  const file = await tmpFile();
  await fs.writeFile(file, content, { mode: 0o755 });
  return file;
}

const HAPPY_SCRIPT = `
process.stdout.write('Welcome to Kimi Code\\n');
process.stdout.write('context: 0% (0/1M)\\n');
let buf = '';
process.stdin.on('data', d => {
  buf += d.toString();
  if (buf.includes('/usage')) {
    setTimeout(() => {
      process.stdout.write('Weekly limit  \\u2588\\u2591\\u2591  7% used   resets in 6d 19h 57m\\n');
      process.stdout.write('5h limit      \\u2588\\u2588\\u2591 33% used  resets in 57m\\n');
    }, 30);
  }
});
setInterval(()=>{}, 1000);
`;

const TIMEOUT_SCRIPT = `
process.stdout.write('Welcome to Kimi Code\\n');
process.stdin.on('data', () => {
  // never emit completion
});
setInterval(()=>{}, 1000);
`;

const MALFORMED_SCRIPT = `
process.stdout.write('Welcome to Kimi Code\\n');
let buf='';
process.stdin.on('data', d=>{
  buf+=d.toString();
  if(buf.includes('/usage')){
    setTimeout(()=>{
      process.stdout.write('Weekly limit  ??? no percent here\\n');
      process.stdout.write('garbage output\\n');
    },30);
  }
});
setInterval(()=>{},1000);
`;

const CLEAN_KILL_SCRIPT = (pidFile: string) => `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdout.write('Welcome to Kimi Code\\n');
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

const CAP_SCRIPT = `
process.stdout.write('Welcome to Kimi Code\\n');
let buf='';
process.stdin.on('data', d=>{
  buf+=d.toString();
  if(buf.includes('/usage')){
    // flood beyond cap
    const chunk = 'x'.repeat(1024);
    let i=0;
    const id=setInterval(()=>{
      process.stdout.write(chunk);
      i++;
      if(i>400) clearInterval(id);
    },5);
  }
});
setInterval(()=>{},1000);
`;

describe("stripAnsi", () => {
  it("removes common escape sequences", () => {
    const raw = "\x1b[31mred\x1b[0m \x1b[2K clear \x1b]0;title\x07 end";
    expect(stripAnsi(raw)).toBe("red  clear  end");
  });
});

describe("runPty", () => {
  it("resolves with transcript on happy-path (ready + completion)", async () => {
    const fake = await writeFake(HAPPY_SCRIPT);
    const transcript = await runPty({
      file: process.execPath,
      args: [fake],
      readyRegex: /Welcome to Kimi Code/,
      readyTimeoutMs: 2000,
      input: "/usage\r",
      completionRegex: /Weekly limit[\s\S]*5h limit/,
      timeoutMs: 2000,
      maxBytes: 64 * 1024,
    });
    const cleaned = stripAnsi(transcript);
    expect(cleaned).toMatch(/Weekly limit/);
    expect(cleaned).toMatch(/5h limit/);
  });

  it("rejects on completion timeout", async () => {
    const fake = await writeFake(TIMEOUT_SCRIPT);
    await expect(
      runPty({
        file: process.execPath,
        args: [fake],
        readyRegex: /Welcome to Kimi Code/,
        readyTimeoutMs: 2000,
        input: "/usage\r",
        completionRegex: /Weekly limit/,
        timeoutMs: 600,
        maxBytes: 64 * 1024,
      }),
    ).rejects.toThrow(/completion timeout/i);
  });

  it("rejects on ready timeout", async () => {
    const fake = await writeFake(`setInterval(()=>{},1000);`);
    await expect(
      runPty({
        file: process.execPath,
        args: [fake],
        readyRegex: /Welcome to Kimi Code/,
        readyTimeoutMs: 500,
        input: "/usage\r",
        completionRegex: /Weekly limit/,
        timeoutMs: 500,
      }),
    ).rejects.toThrow(/ready timeout/i);
  });

  it("rejects when transcript exceeds cap", async () => {
    const fake = await writeFake(CAP_SCRIPT);
    await expect(
      runPty({
        file: process.execPath,
        args: [fake],
        readyRegex: /Welcome to Kimi Code/,
        readyTimeoutMs: 2000,
        input: "/usage\r",
        completionRegex: /Weekly limit/,
        timeoutMs: 1200,
        maxBytes: 8 * 1024,
      }),
    ).rejects.toThrow(/exceeds/);
  });

  it("supports settleDelayMs without readyRegex", async () => {
    const fake = await writeFake(HAPPY_SCRIPT);
    const transcript = await runPty({
      file: process.execPath,
      args: [fake],
      settleDelayMs: 200,
      input: "/usage\r",
      completionRegex: /Weekly limit/,
      timeoutMs: 2000,
    });
    expect(stripAnsi(transcript)).toMatch(/Weekly limit/);
  });

  it("clean-kills the child (no orphan after success)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qc-pid-"));
    const pidFile = path.join(dir, "pid");
    const fake = await writeFake(CLEAN_KILL_SCRIPT(pidFile));
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
    // give kill grace
    await new Promise((r) => setTimeout(r, 400));
    const pidRaw = await fs.readFile(pidFile, "utf8");
    const pid = parseInt(pidRaw, 10);
    let alive = true;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("clean-kills on timeout as well", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qc-pid2-"));
    const pidFile = path.join(dir, "pid");
    const script = `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdout.write('Welcome to Kimi Code\\n');
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
    ).rejects.toThrow(/completion timeout/);
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

  it("aborts on trust prompt when abortOn is set (fail-closed, no silent trust)", async () => {
    const fake = await writeFake(`process.stdout.write('Trust this folder?\\\\n'); setInterval(()=>{},1000);`);
    await expect(
      runPty({
        file: process.execPath,
        args: [fake],
        readyRegex: /Welcome to Kimi Code/,
        readyTimeoutMs: 800,
        input: "/usage\r",
        abortOn: /Trust this folder\?/i,
        completionRegex: /Weekly limit/,
        timeoutMs: 800,
      }),
    ).rejects.toThrow(/untrusted workspace/i);
  });

  it("degrades gracefully when node-pty is unavailable (guarded import)", async () => {
    await expect(
      runPty({
        file: "definitely-not-a-real-binary-xyz-123",
        args: [],
        readyRegex: /Welcome/,
        readyTimeoutMs: 300,
        input: "/usage\r",
        completionRegex: /Weekly/,
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/pty (spawn failed|exited before ready|node-pty not available)/);
  });

  it("rejects with safe DiagnosticError when child exits with terminal error and secret", async () => {
    const fake = await writeFake(
      "process.stderr.write('Error: stdin is not a terminal token=private-value\\n'); process.exit(1);",
    );
    await expect(
      runPty({
        file: process.execPath,
        args: [fake],
        input: "/usage\r",
        readyRegex: /READY/,
        readyTimeoutMs: 1000,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      name: "DiagnosticError",
      diagnostic: {
        diagnosticCode: "terminal_error",
        errorDetail: expect.stringContaining("stdin is not a terminal"),
      },
    });
    expect(liveChildCount()).toBe(0);
  });

  it("classifies premature exit 0 before ready as unknown and cleans up child", async () => {
    const fake = await writeFake("process.exit(0);");
    await expect(
      runPty({
        file: process.execPath,
        args: [fake],
        input: "/usage\r",
        readyRegex: /READY/,
        readyTimeoutMs: 1000,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      name: "DiagnosticError",
      diagnostic: {
        diagnosticCode: "unknown",
        errorDetail: expect.stringContaining("code 0"),
      },
    });
    expect(liveChildCount()).toBe(0);
  });
});

const QUERY_SCRIPT = `
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('READY\\n');
process.stdout.write('\\x1b[6n\\x1b[c\\x1b]4;7;?\\x07\\x1b]10;?\\x07\\x1b]11;?\\x07');
let buf = '';
process.stdin.on('data', d => {
  buf += d.toString();
  const ok = buf.includes('\\x1b[1;1R') && buf.includes('\\x1b[?1;2c') && buf.includes('\\x1b]4;7;rgb') && buf.includes('\\x1b]10;rgb') && buf.includes('\\x1b]11;rgb');
  if (ok && !globalThis.done) { globalThis.done = true; process.stdout.write('QUERIES-ANSWERED\\n'); }
});
setInterval(()=>{},1000);
`;

const QUERY_SILENCE_SCRIPT = `
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('READY\\n');
process.stdout.write('\\x1b[6n');
let saw = false;
process.stdin.on('data', d => { if (d.toString().includes('\\x1b[')) saw = true; });
setTimeout(() => { process.stdout.write(saw ? 'SAW-REPLY\\n' : 'NO-REPLY\\n'); }, 400);
setInterval(()=>{},1000);
`;

const GAP_SCRIPT = `
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('READY\\n');
let t0 = 0; let buf = '';
process.stdin.on('data', d => {
  if (!t0) t0 = Date.now();
  buf += d.toString();
  if ((buf.includes('\\r') || buf.includes('\\n')) && !globalThis.reported) {
    globalThis.reported = true;
    process.stdout.write('GAP:' + (Date.now() - t0) + '\\n');
  }
});
setInterval(()=>{},1000);
`;

const SETTLE_SCRIPT = `
process.stdout.write('READY-MARKER\\n');
const t0 = Date.now();
process.stdin.on('data', () => {
  if (!globalThis.reported) { globalThis.reported = true; process.stdout.write('INPUT-AFTER:' + (Date.now() - t0) + '\\n'); }
});
setInterval(()=>{},1000);
`;

describe("createTerminalQueryResponder", () => {
  function feed(chunks: string[]): string[] {
    const writes: string[] = [];
    const feedChunk = createTerminalQueryResponder((s) => writes.push(s));
    for (const c of chunks) feedChunk(c);
    return writes;
  }

  it("answers DSR ESC[6n with a cursor-position report", () => {
    expect(feed(["\x1b[6n"])).toEqual(["\x1b[1;1R"]);
  });

  it("answers DA1 ESC[c with device attributes", () => {
    expect(feed(["\x1b[c"])).toEqual(["\x1b[?1;2c"]);
  });

  it("answers OSC 4/10/11 colour queries, echoing the palette index", () => {
    const writes = feed(["\x1b]4;7;?\x07", "\x1b]10;?\x07", "\x1b]11;?\x1b\\"]);
    expect(writes).toHaveLength(3);
    expect(writes[0]).toBe("\x1b]4;7;rgb:0000/0000/0000\x07");
    expect(writes[1]).toBe("\x1b]10;rgb:ffff/ffff/ffff\x07");
    expect(writes[2]).toBe("\x1b]11;rgb:0000/0000/0000\x07");
  });

  it("answers a query split across chunks exactly once", () => {
    const writes = feed(["\x1b]4;", "7;?", "\x07", "more output", "\x1b[6", "n"]);
    expect(writes).toEqual(["\x1b]4;7;rgb:0000/0000/0000\x07", "\x1b[1;1R"]);
  });

  it("ignores plain output", () => {
    expect(feed(["Welcome to Muse Code\nmuse-spark-1.3\n"])).toEqual([]);
  });
});

describe("runPty terminal-query responder", () => {
  it("answers DSR, DA1 and OSC queries when respondToQueries is set", async () => {
    const fake = await writeFake(QUERY_SCRIPT);
    const transcript = await runPty({
      file: process.execPath,
      args: [fake],
      readyRegex: /READY/,
      readyTimeoutMs: 2000,
      respondToQueries: true,
      input: "x\r",
      completionRegex: /QUERIES-ANSWERED/,
      timeoutMs: 3000,
      maxBytes: 64 * 1024,
    });
    expect(stripAnsi(transcript)).toMatch(/QUERIES-ANSWERED/);
  });

  it("stays silent by default (no responder without the flag)", async () => {
    const fake = await writeFake(QUERY_SILENCE_SCRIPT);
    const transcript = await runPty({
      file: process.execPath,
      args: [fake],
      readyRegex: /READY/,
      readyTimeoutMs: 2000,
      input: "x\r",
      completionRegex: /SAW-REPLY|NO-REPLY/,
      timeoutMs: 3000,
      maxBytes: 64 * 1024,
    });
    expect(stripAnsi(transcript)).toMatch(/NO-REPLY/);
  });
});

describe("runPty two-phase write", () => {
  function gapMs(transcript: string): number {
    const m = stripAnsi(transcript).match(/GAP:(\d+)/);
    if (!m) throw new Error("fake child never reported a gap");
    return parseInt(m[1], 10);
  }

  it("writes submitInput after submitAfterMs", async () => {
    const fake = await writeFake(GAP_SCRIPT);
    const transcript = await runPty({
      file: process.execPath,
      args: [fake],
      readyRegex: /READY/,
      readyTimeoutMs: 2000,
      input: "/usage",
      submitInput: "\r",
      submitAfterMs: 300,
      completionRegex: /GAP:\d+/,
      timeoutMs: 3000,
      maxBytes: 64 * 1024,
    });
    expect(gapMs(transcript)).toBeGreaterThanOrEqual(200);
  });

  it("performs a single write when submitInput is absent", async () => {
    const fake = await writeFake(GAP_SCRIPT);
    const transcript = await runPty({
      file: process.execPath,
      args: [fake],
      readyRegex: /READY/,
      readyTimeoutMs: 2000,
      input: "/usage\r",
      completionRegex: /GAP:\d+/,
      timeoutMs: 3000,
      maxBytes: 64 * 1024,
    });
    expect(gapMs(transcript)).toBeLessThan(1000);
  });

  it("honours settleDelayMs after readyRegex", async () => {
    const fake = await writeFake(SETTLE_SCRIPT);
    const transcript = await runPty({
      file: process.execPath,
      args: [fake],
      readyRegex: /READY-MARKER/,
      readyTimeoutMs: 2000,
      settleDelayMs: 800,
      input: "x\r",
      completionRegex: /INPUT-AFTER:\d+/,
      timeoutMs: 3000,
      maxBytes: 64 * 1024,
    });
    const m = stripAnsi(transcript).match(/INPUT-AFTER:(\d+)/);
    expect(m).not.toBeNull();
    expect(parseInt(m![1], 10)).toBeGreaterThanOrEqual(700);
  });

  it("leaves codex, kimi and grok on the single-write path (new flags absent)", async () => {
    const seen: Array<{ file: string; opts: Record<string, unknown> }> = [];
    const spy = vi.spyOn(ptyMod, "runPty").mockImplementation(async (opts) => {
      seen.push({ file: opts.file, opts: opts as unknown as Record<string, unknown> });
      if (opts.file === "codex") {
        return "5h limit: 9% left (resets 14:12)\nWeekly limit: 73% left (resets 16:36 on 7 Sep)\n";
      }
      if (opts.file === "kimi") {
        return "Welcome to Kimi Code\nWeekly limit  7% used   resets in 6d 19h 57m\n5h limit      33% used  resets in 57m\n";
      }
      if (opts.file === "grok") {
        return "Weekly limit (SuperGrok)  26%\nCredits: $4.85\nResets: September 7, 10:22\n";
      }
      throw new Error(`Unexpected pty file: ${opts.file}`);
    });
    try {
      await codexAdapter.poll();
      await kimiAdapter.poll();
      await grokAdapter.poll();
    } finally {
      spy.mockRestore();
    }
    expect(seen).toHaveLength(3);
    for (const { file, opts } of seen) {
      expect(opts["respondToQueries"], file).toBeUndefined();
      expect(opts["submitInput"], file).toBeUndefined();
      expect(opts["submitAfterMs"], file).toBeUndefined();
    }
    expect(seen.find((s) => s.file === "codex")!.opts["settleDelayMs"]).toBe(2000);
    expect(seen.find((s) => s.file === "grok")!.opts["settleDelayMs"]).toBe(5000);
    expect(seen.find((s) => s.file === "kimi")!.opts["settleDelayMs"]).toBeUndefined();
  });
});
