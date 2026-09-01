import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[^A-Za-z]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\][^\x1b]*\x1b\\/g, "")
    .replace(/\x1b\([A-B0-2]/g, "")
    .replace(/\x1b[=>]|\x1b7|\x1b8|\x1bD|\x1bM/g, "");
}

export interface PtyRunOptions {
  file: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  readyRegex?: RegExp;
  readyTimeoutMs?: number;
  settleDelayMs?: number;
  input: string;
  completionRegex?: RegExp;
  /** If matched, abort immediately with a clear error (e.g. trust prompts). */
  abortOn?: RegExp;
  timeoutMs: number;
  maxBytes?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function regexTest(re: RegExp, s: string): boolean {
  const fresh = new RegExp(re.source, re.flags.replace("g", ""));
  return fresh.test(s);
}

let ptyMod: any | null = null;
function getPty(): any {
  if (ptyMod) return ptyMod;
  try {
    const require = createRequire(import.meta.url);
    ptyMod = require("node-pty");
    if (ptyMod?.spawn) return ptyMod;
  } catch {}
  // Compiled binary (bun --compile) has no node_modules; try sidecar locations
  const execDir = path.dirname(process.execPath);
  const platformArch = `${process.platform}-${process.arch}`;
  const candidates = [
    path.join(execDir, "pty", "node-pty"),
    path.join(execDir, "node-pty"),
    path.join(execDir, "..", "share", "quotacap", "pty", "node-pty"),
    path.join(os.homedir(), ".local", "share", "quotacap", "pty", "node-pty"),
    path.join(os.homedir(), ".local", "share", "quotacap", "pty", platformArch, "node-pty"),
    path.join(os.homedir(), ".quotacap", "pty", "node-pty"),
  ];
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) continue;
      const require2 = createRequire(import.meta.url);
      const mod = require2(c);
      if (mod?.spawn) {
        ptyMod = mod;
        return ptyMod;
      }
    } catch {}
    try {
      const libIndex = path.join(c, "lib", "index.js");
      if (!fs.existsSync(libIndex)) continue;
      const require3 = createRequire(import.meta.url);
      const mod = require3(libIndex);
      if (mod?.spawn) {
        ptyMod = mod;
        return ptyMod;
      }
    } catch {}
  }
  throw new Error(
    "pty: node-pty not available — install with build tools (Xcode on macOS, build-essential + python3 on Linux) or use exec-based adapters only; for compiled binaries, ensure the pty sidecar is installed alongside the binary (see install.sh)",
  );
}

function isBunRuntime(): boolean {
  return typeof (globalThis as any).Bun !== "undefined" && typeof (globalThis as any).Bun.spawn === "function";
}

async function runPtyBun(opts: PtyRunOptions): Promise<string> {
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const cols = opts.cols ?? 140;
  const rows = opts.rows ?? 50;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 6000;
  if (opts.timeoutMs <= 0) throw new Error("pty: timeoutMs must be > 0");

  const BunGlobal: any = (globalThis as any).Bun;
  let transcript = "";
  let exited = false;
  let exitCode: number | undefined;

  const proc: any = BunGlobal.spawn([opts.file, ...(opts.args ?? [])], {
    cwd: opts.cwd ?? process.cwd(),
    env: {
      ...(process.env as Record<string, string>),
      ...(opts.env ?? {}),
      TERM: "xterm-256color",
    },
    stdin: "pipe",
    pty: { cols, rows },
  });

  // Capture stdout (pty merges stdout+stderr)
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let reading = true;
  const readLoop = (async () => {
    try {
      while (reading) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) transcript += decoder.decode(value);
      }
    } catch {}
  })();

  // Poll for exit
  const exitPoll = (async () => {
    try {
      const code = await proc.exited;
      exited = true;
      exitCode = code;
    } catch {}
  })();

  const checkCap = () => {
    if (Buffer.byteLength(transcript, "utf8") > maxBytes) {
      throw new Error(`pty transcript exceeds ${maxBytes} bytes`);
    }
  };
  const checkAbort = (clean: string) => {
    if (opts.abortOn && regexTest(opts.abortOn, clean)) {
      throw new Error(
        `pty: untrusted workspace — trust prompt detected in ${opts.cwd ?? process.cwd()} — run \`${opts.file}\` there and select Trust this folder`,
      );
    }
  };
  const kill = async () => {
    if (exited) return;
    try { proc.kill(); } catch {}
    for (let i = 0; i < 6; i++) {
      await delay(100);
      if (exited) return;
    }
    try { proc.kill(9); } catch {}
    for (let i = 0; i < 5; i++) {
      await delay(100);
      if (exited) return;
    }
  };

  try {
    if (opts.readyRegex) {
      const deadline = Date.now() + readyTimeoutMs;
      let matched = false;
      while (Date.now() < deadline) {
        checkCap();
        if (exited) throw new Error(`pty exited before ready (code ${exitCode})`);
        const clean = stripAnsi(transcript);
        checkAbort(clean);
        if (regexTest(opts.readyRegex, clean)) {
          matched = true;
          break;
        }
        await delay(40);
      }
      if (!matched) {
        await kill();
        throw new Error(`pty ready timeout after ${readyTimeoutMs}ms`);
      }
      await delay(200);
      checkCap();
      if (exited) throw new Error(`pty exited before input (code ${exitCode})`);
      const postReadyClean = stripAnsi(transcript);
      checkAbort(postReadyClean);
    } else if (opts.settleDelayMs) {
      await delay(opts.settleDelayMs);
      checkCap();
      if (exited) throw new Error(`pty exited during settle (code ${exitCode})`);
      const c = stripAnsi(transcript);
      checkAbort(c);
    }

    if (exited) throw new Error(`pty exited before input (code ${exitCode})`);
    try {
      proc.stdin.write(opts.input);
      if (typeof proc.stdin.flush === "function") proc.stdin.flush();
    } catch (e) {
      throw new Error(`pty write failed: ${(e as Error).message}`);
    }

    if (opts.completionRegex) {
      const deadline = Date.now() + opts.timeoutMs;
      let done = false;
      while (Date.now() < deadline) {
        checkCap();
        const clean = stripAnsi(transcript);
        checkAbort(clean);
        if (regexTest(opts.completionRegex, clean)) {
          done = true;
          break;
        }
        if (exited) {
          if (!regexTest(opts.completionRegex, clean)) {
            throw new Error(`pty exited before completion (code ${exitCode})`);
          }
          done = true;
          break;
        }
        await delay(40);
      }
      if (!done) {
        await kill();
        throw new Error(`pty completion timeout after ${opts.timeoutMs}ms`);
      }
    } else {
      const deadline = Date.now() + opts.timeoutMs;
      while (Date.now() < deadline) {
        checkCap();
        const c = stripAnsi(transcript);
        checkAbort(c);
        if (exited) break;
        await delay(40);
      }
    }

    await kill();
    reading = false;
    try { reader.cancel(); } catch {}
    await Promise.race([readLoop, delay(200)]);
    checkCap();
    const finalClean = stripAnsi(transcript);
    checkAbort(finalClean);
    return transcript;
  } catch (e) {
    reading = false;
    try { reader.cancel(); } catch {}
    await kill();
    throw e;
  }
}

async function runPtyNode(opts: PtyRunOptions): Promise<string> {
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const cols = opts.cols ?? 140;
  const rows = opts.rows ?? 50;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 6000;
  if (opts.timeoutMs <= 0) throw new Error("pty: timeoutMs must be > 0");

  let transcript = "";
  let exited = false;
  let exitCode: number | undefined;

  const pty = getPty();
  let ptyProcess: any;
  try {
    ptyProcess = pty.spawn(opts.file, opts.args ?? [], {
      name: "xterm-color",
      cols,
      rows,
      cwd: opts.cwd ?? process.cwd(),
      env: {
        ...(process.env as Record<string, string>),
        ...(opts.env ?? {}),
        TERM: "xterm-256color",
      },
    });
  } catch (e) {
    throw new Error(`pty spawn failed for ${opts.file}: ${(e as Error).message}`);
  }

  const disposables: any[] = [];
  disposables.push(
    ptyProcess.onData((data: string) => {
      transcript += data;
    }),
  );
  disposables.push(
    ptyProcess.onExit(({ exitCode: c }: { exitCode: number }) => {
      exited = true;
      exitCode = c;
    }),
  );

  const cleanup = () => {
    for (const d of disposables) {
      try {
        d.dispose();
      } catch {}
    }
  };

  const kill = async () => {
    if (exited) return;
    try {
      ptyProcess.kill("SIGINT");
    } catch {}
    for (let i = 0; i < 6; i++) {
      await delay(100);
      if (exited) return;
    }
    try {
      ptyProcess.kill("SIGKILL");
    } catch {}
    for (let i = 0; i < 5; i++) {
      await delay(100);
      if (exited) return;
    }
  };

  const checkCap = () => {
    if (Buffer.byteLength(transcript, "utf8") > maxBytes) {
      throw new Error(`pty transcript exceeds ${maxBytes} bytes`);
    }
  };

  const checkAbort = (clean: string) => {
    if (opts.abortOn && regexTest(opts.abortOn, clean)) {
      throw new Error(
        `pty: untrusted workspace — trust prompt detected in ${opts.cwd ?? process.cwd()} — run \`${opts.file}\` there and select Trust this folder`,
      );
    }
  };

  try {
    if (opts.readyRegex) {
      const deadline = Date.now() + readyTimeoutMs;
      let matched = false;
      while (Date.now() < deadline) {
        checkCap();
        if (exited) throw new Error(`pty exited before ready (code ${exitCode})`);
        const clean = stripAnsi(transcript);
        checkAbort(clean);
        if (regexTest(opts.readyRegex, clean)) {
          matched = true;
          break;
        }
        await delay(40);
      }
      if (!matched) {
        await kill();
        throw new Error(`pty ready timeout after ${readyTimeoutMs}ms`);
      }
      await delay(200);
      checkCap();
      if (exited) throw new Error(`pty exited before input (code ${exitCode})`);
      const postReadyClean = stripAnsi(transcript);
      checkAbort(postReadyClean);
    } else if (opts.settleDelayMs) {
      await delay(opts.settleDelayMs);
      checkCap();
      if (exited) throw new Error(`pty exited during settle (code ${exitCode})`);
      const c = stripAnsi(transcript);
      checkAbort(c);
    }

    if (exited) throw new Error(`pty exited before input (code ${exitCode})`);
    ptyProcess.write(opts.input);

    if (opts.completionRegex) {
      const deadline = Date.now() + opts.timeoutMs;
      let done = false;
      while (Date.now() < deadline) {
        checkCap();
        const clean = stripAnsi(transcript);
        checkAbort(clean);
        if (regexTest(opts.completionRegex, clean)) {
          done = true;
          break;
        }
        if (exited) {
          if (!regexTest(opts.completionRegex, clean)) {
            throw new Error(`pty exited before completion (code ${exitCode})`);
          }
          done = true;
          break;
        }
        await delay(40);
      }
      if (!done) {
        await kill();
        throw new Error(`pty completion timeout after ${opts.timeoutMs}ms`);
      }
    } else {
      const deadline = Date.now() + opts.timeoutMs;
      while (Date.now() < deadline) {
        checkCap();
        const c = stripAnsi(transcript);
        checkAbort(c);
        if (exited) break;
        await delay(40);
      }
    }

    await kill();
    checkCap();
    const finalClean = stripAnsi(transcript);
    checkAbort(finalClean);
    return transcript;
  } catch (e) {
    await kill();
    throw e;
  } finally {
    cleanup();
  }
}

export async function runPty(opts: PtyRunOptions): Promise<string> {
  if (isBunRuntime()) {
    return runPtyBun(opts);
  }
  return runPtyNode(opts);
}
