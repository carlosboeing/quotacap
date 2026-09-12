import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPty, stripAnsi } from "../../src/adapters/pty.ts";

if (typeof (globalThis as any).Bun === "undefined") {
  throw new Error("bun-only suite: run with `bun test tests/bun/`");
}

function writeFake(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qc-bun-pty-"));
  const file = path.join(dir, "fake.mjs");
  fs.writeFileSync(file, content, { mode: 0o755 });
  return file;
}

// Issue #42: the standalone binary must present a genuine terminal to the
// child — stdin, stdout, and stderr all TTYs — with programmatic input and
// merged-output capture. These tests fail on the old `stdin: "pipe"` plus
// ignored-`pty` spawn shape and pass on the `terminal` shape.

test(
  "bun pty: child sees TTY on all three fds via node isTTY",
  async () => {
    const fake = writeFake(`
console.log("READY");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  if (buf.includes("/check")) {
    console.log("tty0=" + !!process.stdin.isTTY + " tty1=" + !!process.stdout.isTTY + " tty2=" + !!process.stderr.isTTY);
  }
});
setInterval(() => {}, 1000);
`);
    const transcript = await runPty({
      file: "node",
      args: [fake],
      readyRegex: /READY/,
      readyTimeoutMs: 5000,
      input: "/check\r",
      completionRegex: /tty0=/,
      timeoutMs: 5000,
      maxBytes: 64 * 1024,
    });
    expect(stripAnsi(transcript)).toContain("tty0=true tty1=true tty2=true");
  },
  15000,
);

test(
  "bun pty: child sees TTY on all three fds via test -t",
  async () => {
    const transcript = await runPty({
      file: "sh",
      args: ["-c", 'echo READY; read l; test -t 0; a=$?; test -t 1; b=$?; test -t 2; c=$?; echo "RESULT $a$b$c"'],
      readyRegex: /READY/,
      readyTimeoutMs: 5000,
      input: "go\r",
      completionRegex: /RESULT/,
      timeoutMs: 5000,
      maxBytes: 64 * 1024,
    });
    expect(stripAnsi(transcript)).toContain("RESULT 000");
  },
  15000,
);

test(
  "bun pty: completion timeout still kills the child (no orphan)",
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qc-bun-pid-"));
    const pidFile = path.join(dir, "pid");
    const fake = writeFake(`
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
console.log("READY");
process.stdin.on("data", () => {});
setInterval(() => {}, 1000);
`);
    await expect(
      runPty({
        file: "node",
        args: [fake],
        readyRegex: /READY/,
        readyTimeoutMs: 5000,
        input: "/usage\r",
        completionRegex: /Weekly limit/,
        timeoutMs: 800,
      }),
    ).rejects.toThrow(/completion timeout/i);
    await new Promise((r) => setTimeout(r, 400));
    const pid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    let alive = true;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  },
  15000,
);

test(
  "bun pty: safe DiagnosticError on terminal error with secret stripped",
  async () => {
    const fake = writeFake(`
console.log("READY");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  if (buf.includes("/check")) {
    process.stderr.write("Error: stdin is not a terminal token=secret-bun-val\\n");
    process.exit(1);
  }
});
setInterval(() => {}, 1000);
`);
    let capturedParentStderr = "";
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any, ...args: any[]) => {
      capturedParentStderr += String(chunk);
      return (origStderrWrite as any)(chunk, ...args);
    };

    let capturedErr: any = null;
    try {
      await runPty({
        file: "node",
        args: [fake],
        readyRegex: /READY/,
        readyTimeoutMs: 5000,
        input: "/check\r",
        completionRegex: /COMPLETED/,
        timeoutMs: 5000,
      });
    } catch (e: any) {
      capturedErr = e;
    } finally {
      process.stderr.write = origStderrWrite;
    }

    expect(capturedErr).not.toBeNull();
    expect(capturedErr.name).toBe("DiagnosticError");
    expect(capturedErr.diagnostic.diagnosticCode).toBe("terminal_error");
    expect(capturedErr.diagnostic.errorDetail).toContain("stdin is not a terminal");
    expect(JSON.stringify(capturedErr)).not.toContain("secret-bun-val");
    expect(capturedErr.message).not.toContain("secret-bun-val");
    expect(capturedParentStderr).not.toContain("secret-bun-val");
  },
  15000,
);
