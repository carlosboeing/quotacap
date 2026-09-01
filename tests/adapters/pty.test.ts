import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPty, stripAnsi } from "../../src/adapters/pty.js";

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
});
