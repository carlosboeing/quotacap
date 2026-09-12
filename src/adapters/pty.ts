import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { registerTrackedChild } from "../runtime/spawn.js";
import { diagnosticError, DiagnosticError } from "../diagnostics/failure.js";

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
  /**
   * Settle delay after spawn (no readyRegex) or after readiness (with
   * readyRegex). The post-ready default stays 200ms; pass an explicit value
   * (e.g. muse's 1000ms) only when the TUI needs longer after signalling.
   */
  settleDelayMs?: number;
  input: string;
  /**
   * Second-phase input, written `submitAfterMs` after `input`. Both must be
   * set for the second write to happen; absent by default, which keeps the
   * historical single-write behaviour for existing adapters.
   */
  submitInput?: string;
  submitAfterMs?: number;
  /**
   * Opt-in terminal-query responder: answers DSR, DA1 and OSC 4/10/11
   * capability queries the child emits. Off by default; TUIs that never
   * query (codex, kimi, grok) are unaffected either way.
   */
  respondToQueries?: boolean;
  completionRegex?: RegExp;
  /** If matched, abort immediately with a clear error (e.g. trust prompts). */
  abortOn?: RegExp;
  timeoutMs: number;
  maxBytes?: number;
  /** Abort kills the child via the existing kill path and rejects `pty aborted`. */
  signal?: AbortSignal;
  /** Diagnostic label for the tracked child (adapter id). */
  label?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function regexTest(re: RegExp, s: string): boolean {
  const fresh = new RegExp(re.source, re.flags.replace("g", ""));
  return fresh.test(s);
}

export interface TerminalQueryRule {
  /** Non-global pattern; must match the complete query including terminator. */
  match: RegExp;
  reply: (m: RegExpMatchArray) => string;
}

/**
 * Canned answers to terminal capability queries, table-driven so a future
 * query type is a one-line row. Replies are static: colour answers never
 * affect parsing because styling is stripped before matching.
 */
export const TERMINAL_QUERY_RESPONSES: TerminalQueryRule[] = [
  // DSR (device status report): cursor position request. Unanswered, some
  // TUIs exit outright ("cursor position could not be read").
  { match: /\x1b\[[0-9;]*6n/, reply: () => "\x1b[1;1R" },
  // DA1 (primary device attributes): `CSI c` is exclusively a DA request.
  { match: /\x1b\[[0-9;]*c/, reply: () => "\x1b[?1;2c" },
  // OSC 4/10/11 colour queries, BEL- or ST-terminated. The palette index is
  // echoed back; 16 OSC 4 queries were measured in a single Muse startup.
  { match: /\x1b\]4;(\d+);\?(?:\x07|\x1b\\)/, reply: (m) => `\x1b]4;${m[1]};rgb:0000/0000/0000\x07` },
  { match: /\x1b\]10;\?(?:\x07|\x1b\\)/, reply: () => "\x1b]10;rgb:ffff/ffff/ffff\x07" },
  { match: /\x1b\]11;\?(?:\x07|\x1b\\)/, reply: () => "\x1b]11;rgb:0000/0000/0000\x07" },
];

/**
 * Stateful feeder for `TERMINAL_QUERY_RESPONSES`. Consumes each matched query
 * from an internal buffer, so a query split across chunks is answered once it
 * completes and never answered twice. Plain output passes through silently.
 */
export function createTerminalQueryResponder(write: (s: string) => void): (chunk: string) => void {
  let buf = "";
  return (chunk: string) => {
    buf += chunk;
    let progress = true;
    while (progress) {
      progress = false;
      for (const rule of TERMINAL_QUERY_RESPONSES) {
        const m = rule.match.exec(buf);
        if (m?.index !== undefined) {
          write(rule.reply(m));
          buf = buf.slice(0, m.index) + buf.slice(m.index + m[0].length);
          progress = true;
          break;
        }
      }
    }
    // Bounded tail: a partial query can only straddle the end of the stream,
    // and the longest query is well under 64 bytes.
    if (buf.length > 64) buf = buf.slice(-64);
  };
}

export interface SpawnHelperRepair {
  helper: string;
  ok: boolean;
  error?: string;
}

/**
 * Lazy replacement for the removed postinstall: best-effort `chmod 0o755`
 * over every prebuilds entry `spawn-helper` under the given node-pty roots.
 * Missing roots, missing prebuild dirs, and missing helpers are skipped
 * silently; only attempted repairs are recorded.
 */
export function repairSpawnHelpers(
  roots: string[],
  chmod: (p: string, mode: number) => void = fs.chmodSync,
): SpawnHelperRepair[] {
  const outcomes: SpawnHelperRepair[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(path.join(root, "prebuilds"));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const helper = path.join(root, "prebuilds", entry, "spawn-helper");
      if (seen.has(helper)) continue;
      seen.add(helper);
      try {
        if (!fs.existsSync(helper)) continue;
      } catch {
        continue;
      }
      try {
        chmod(helper, 0o755);
        outcomes.push({ helper, ok: true });
      } catch (e: any) {
        outcomes.push({ helper, ok: false, error: String(e?.message ?? e) });
      }
    }
  }
  return outcomes;
}

/**
 * Human diagnostic for failed repairs, or null when nothing failed.
 * Load-bearing for root-owned trees (e.g. `sudo` global installs) where the
 * invoking user cannot repair: without it the failure would go opaque again.
 */
export function describeSpawnHelperRepairs(outcomes: SpawnHelperRepair[]): string | null {
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length === 0) return null;
  const lines = failed.map((o) => `could not make ${o.helper} executable (${o.error ?? "unknown error"})`);
  return (
    `${lines.join("; ")} — the install tree is likely root-owned (e.g. installed with sudo); ` +
    `reinstall without sudo or fix the install's ownership so the invoking user can write it`
  );
}

function nodePtyPackageRoot(resolvedEntry: string): string {
  const dir = path.dirname(resolvedEntry);
  // node-pty's main entry is lib/index.js; the package root is two levels up.
  if (path.basename(dir) === "lib" && /^index\.[cm]?js$/.test(path.basename(resolvedEntry))) {
    return path.dirname(dir);
  }
  return dir;
}

let ptyMod: any | null = null;
function getPty(): any {
  if (ptyMod) return ptyMod;
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
  // Best-effort +x before requiring: the resolvable npm root (when present)
  // plus every existing sidecar root. Successful repairs stay silent.
  const repairRoots: string[] = [];
  try {
    const require0 = createRequire(import.meta.url);
    repairRoots.push(nodePtyPackageRoot(require0.resolve("node-pty")));
  } catch {}
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) repairRoots.push(c);
    } catch {}
  }
  const repairs = repairSpawnHelpers(repairRoots);
  try {
    const require = createRequire(import.meta.url);
    ptyMod = require("node-pty");
    if (ptyMod?.spawn) return ptyMod;
  } catch {}
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
  const repairNote = describeSpawnHelperRepairs(repairs);
  throw diagnosticError(
    new Error(
      "pty: node-pty not available — install with build tools (Xcode on macOS, build-essential + python3 on Linux) or use exec-based adapters only; for compiled binaries, ensure the pty sidecar is installed alongside the binary (see install.sh)" +
        (repairNote ? `; ${repairNote}` : ""),
    ),
    { source: "pty" },
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
  if (opts.timeoutMs <= 0) throw diagnosticError(new Error("pty: timeoutMs must be > 0"), { source: "pty" });
  if (opts.signal?.aborted) throw diagnosticError(new Error("pty aborted"), { source: "pty", checkpoint: "abort" });
  let aborted = false;
  const onAbort = () => {
    aborted = true;
  };
  if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
  const checkAborted = () => {
    if (aborted) throw diagnosticError(new Error("pty aborted"), { source: "pty", checkpoint: "abort", stdout: transcript });
  };
  const teardownAbort = () => {
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  };

  const BunGlobal: any = (globalThis as any).Bun;
  let transcript = "";
  let exited = false;
  let exitCode: number | undefined;

  // Genuine PTY via the Bun.spawn `terminal` option (verified on Bun 1.3.11):
  // the child's stdin, stdout, and stderr are all the PTY slave, input goes
  // through proc.terminal.write, and merged output arrives in `data`.
  // proc.stdin/stdout/stderr are null in this mode.
  const decoder = new TextDecoder();
  let feedQueries: ((chunk: string) => void) | null = null;
  const proc: any = BunGlobal.spawn([opts.file, ...(opts.args ?? [])], {
    cwd: opts.cwd ?? process.cwd(),
    env: {
      ...(process.env as Record<string, string>),
      ...(opts.env ?? {}),
      TERM: "xterm-256color",
    },
    terminal: {
      cols,
      rows,
      data(_term: any, chunk: any) {
        try {
          const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
          transcript += text;
          feedQueries?.(text);
        } catch {}
      },
    },
  });
  if (!proc.terminal) {
    // Old Bun runtimes silently ignore the unknown `terminal` option, so an
    // absent proc.terminal is the fail-loud signal — never run half-attached.
    try {
      proc.kill();
    } catch {}
    throw diagnosticError(
      new Error(
        "pty: Bun runtime lacks terminal (PTY) support (Bun.spawn terminal option unavailable) — rebuild the standalone binary with a newer Bun version",
      ),
      { source: "pty" },
    );
  }
  if (opts.respondToQueries) {
    feedQueries = createTerminalQueryResponder((s) => {
      try {
        proc.terminal.write(s);
      } catch {}
    });
  }

  // Poll for exit
  const exitPoll = (async () => {
    try {
      const code = await proc.exited;
      exited = true;
      exitCode = code;
    } catch {}
  })();
  void exitPoll;

  const checkCap = () => {
    if (Buffer.byteLength(transcript, "utf8") > maxBytes) {
      throw diagnosticError(new Error(`pty transcript exceeds ${maxBytes} bytes`), {
        source: "pty",
        checkpoint: "transcript overflow",
        stdout: transcript,
      });
    }
  };
  const checkAbort = (clean: string) => {
    if (opts.abortOn && regexTest(opts.abortOn, clean)) {
      throw diagnosticError(
        new Error(
          `pty: untrusted workspace — trust prompt detected in ${opts.cwd ?? process.cwd()} — run \`${opts.file}\` there and select Trust this folder`,
        ),
        {
          source: "pty",
          checkpoint: "trust prompt",
          stdout: transcript,
        },
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

  const unregisterChild = registerTrackedChild(() => {
    try {
      proc.kill();
    } catch {}
    try {
      proc.terminal?.close();
    } catch {}
  }, opts.label ?? opts.file);

  try {
    if (opts.readyRegex) {
      const deadline = Date.now() + readyTimeoutMs;
      let matched = false;
      while (Date.now() < deadline) {
        checkCap();
        checkAborted();
        if (exited) {
          throw diagnosticError(new Error(`pty exited before ready (code ${exitCode})`), {
            source: "pty",
            checkpoint: "before ready",
            exitCode,
            stdout: transcript,
          });
        }
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
        throw diagnosticError(new Error(`pty ready timeout after ${readyTimeoutMs}ms`), {
          source: "pty",
          checkpoint: "ready timeout",
          durationMs: readyTimeoutMs,
          stdout: transcript,
        });
      }
      await delay(opts.settleDelayMs ?? 200);
      checkCap();
      checkAborted();
      if (exited) {
        throw diagnosticError(new Error(`pty exited before input (code ${exitCode})`), {
          source: "pty",
          checkpoint: "before input",
          exitCode,
          stdout: transcript,
        });
      }
      const postReadyClean = stripAnsi(transcript);
      checkAbort(postReadyClean);
    } else if (opts.settleDelayMs) {
      await delay(opts.settleDelayMs);
      checkCap();
      checkAborted();
      if (exited) {
        throw diagnosticError(new Error(`pty exited during settle (code ${exitCode})`), {
          source: "pty",
          checkpoint: "during settle",
          exitCode,
          stdout: transcript,
        });
      }
      const c = stripAnsi(transcript);
      checkAbort(c);
    }

    if (exited) {
      throw diagnosticError(new Error(`pty exited before input (code ${exitCode})`), {
        source: "pty",
        checkpoint: "before input",
        exitCode,
        stdout: transcript,
      });
    }
    try {
      proc.terminal.write(opts.input);
    } catch (e) {
      throw diagnosticError(new Error(`pty write failed: ${(e as Error).message}`), {
        source: "pty",
        checkpoint: "write",
        stdout: transcript,
      });
    }
    if (opts.submitInput !== undefined && opts.submitAfterMs !== undefined) {
      await delay(opts.submitAfterMs);
      checkCap();
      checkAborted();
      if (exited) {
        throw diagnosticError(new Error(`pty exited before input (code ${exitCode})`), {
          source: "pty",
          checkpoint: "before input",
          exitCode,
          stdout: transcript,
        });
      }
      try {
        proc.terminal.write(opts.submitInput);
      } catch (e) {
        throw diagnosticError(new Error(`pty write failed: ${(e as Error).message}`), {
          source: "pty",
          checkpoint: "write",
          stdout: transcript,
        });
      }
    }

    if (opts.completionRegex) {
      const deadline = Date.now() + opts.timeoutMs;
      let done = false;
      while (Date.now() < deadline) {
        checkCap();
        checkAborted();
        const clean = stripAnsi(transcript);
        checkAbort(clean);
        if (regexTest(opts.completionRegex, clean)) {
          done = true;
          break;
        }
        if (exited) {
          if (!regexTest(opts.completionRegex, clean)) {
            throw diagnosticError(new Error(`pty exited before completion (code ${exitCode})`), {
              source: "pty",
              checkpoint: "before completion",
              exitCode,
              stdout: transcript,
            });
          }
          done = true;
          break;
        }
        await delay(40);
      }
      if (!done) {
        await kill();
        throw diagnosticError(new Error(`pty completion timeout after ${opts.timeoutMs}ms`), {
          source: "pty",
          checkpoint: "completion timeout",
          durationMs: opts.timeoutMs,
          stdout: transcript,
        });
      }
    } else {
      const deadline = Date.now() + opts.timeoutMs;
      while (Date.now() < deadline) {
        checkCap();
        checkAborted();
        const c = stripAnsi(transcript);
        checkAbort(c);
        if (exited) break;
        await delay(40);
      }
    }

    await kill();
    // Drain late `data` callbacks, then close the terminal and flush the
    // streamed decoder before the final checks.
    await delay(200);
    try {
      proc.terminal.close();
    } catch {}
    try {
      transcript += decoder.decode();
    } catch {}
    checkCap();
    checkAborted();
    const finalClean = stripAnsi(transcript);
    checkAbort(finalClean);
    unregisterChild();
    teardownAbort();
    return transcript;
  } catch (e) {
    await kill();
    try {
      proc.terminal.close();
    } catch {}
    unregisterChild();
    teardownAbort();
    if (e instanceof DiagnosticError) throw e;
    throw diagnosticError(e, { source: "pty", stdout: transcript, exitCode });
  }
}

async function runPtyNode(opts: PtyRunOptions): Promise<string> {
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const cols = opts.cols ?? 140;
  const rows = opts.rows ?? 50;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 6000;
  if (opts.timeoutMs <= 0) throw diagnosticError(new Error("pty: timeoutMs must be > 0"), { source: "pty" });
  if (opts.signal?.aborted) throw diagnosticError(new Error("pty aborted"), { source: "pty", checkpoint: "abort" });
  let aborted = false;
  const onAbort = () => {
    aborted = true;
  };
  if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
  const checkAborted = () => {
    if (aborted) throw diagnosticError(new Error("pty aborted"), { source: "pty", checkpoint: "abort", stdout: transcript });
  };
  const teardownAbort = () => {
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  };

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
    throw diagnosticError(new Error(`pty spawn failed for ${opts.file}: ${(e as Error).message}`), {
      source: "pty",
      checkpoint: "spawn",
    });
  }

  const unregisterChild = registerTrackedChild(() => {
    try {
      ptyProcess.kill("SIGTERM");
    } catch {}
  }, opts.label ?? opts.file);

  const feedQueries = opts.respondToQueries
    ? createTerminalQueryResponder((s) => {
        try {
          ptyProcess.write(s);
        } catch {}
      })
    : null;
  const disposables: any[] = [];
  disposables.push(
    ptyProcess.onData((data: string) => {
      transcript += data;
      try {
        feedQueries?.(data);
      } catch {}
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
      throw diagnosticError(new Error(`pty transcript exceeds ${maxBytes} bytes`), {
        source: "pty",
        checkpoint: "transcript overflow",
        stdout: transcript,
      });
    }
  };

  const checkAbort = (clean: string) => {
    if (opts.abortOn && regexTest(opts.abortOn, clean)) {
      throw diagnosticError(
        new Error(
          `pty: untrusted workspace — trust prompt detected in ${opts.cwd ?? process.cwd()} — run \`${opts.file}\` there and select Trust this folder`,
        ),
        {
          source: "pty",
          checkpoint: "trust prompt",
          stdout: transcript,
        },
      );
    }
  };

  try {
    if (opts.readyRegex) {
      const deadline = Date.now() + readyTimeoutMs;
      let matched = false;
      while (Date.now() < deadline) {
        checkCap();
        checkAborted();
        if (exited) {
          throw diagnosticError(new Error(`pty exited before ready (code ${exitCode})`), {
            source: "pty",
            checkpoint: "before ready",
            exitCode,
            stdout: transcript,
          });
        }
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
        throw diagnosticError(new Error(`pty ready timeout after ${readyTimeoutMs}ms`), {
          source: "pty",
          checkpoint: "ready timeout",
          durationMs: readyTimeoutMs,
          stdout: transcript,
        });
      }
      await delay(opts.settleDelayMs ?? 200);
      checkCap();
      checkAborted();
      if (exited) {
        throw diagnosticError(new Error(`pty exited before input (code ${exitCode})`), {
          source: "pty",
          checkpoint: "before input",
          exitCode,
          stdout: transcript,
        });
      }
      const postReadyClean = stripAnsi(transcript);
      checkAbort(postReadyClean);
    } else if (opts.settleDelayMs) {
      await delay(opts.settleDelayMs);
      checkCap();
      checkAborted();
      if (exited) {
        throw diagnosticError(new Error(`pty exited during settle (code ${exitCode})`), {
          source: "pty",
          checkpoint: "during settle",
          exitCode,
          stdout: transcript,
        });
      }
      const c = stripAnsi(transcript);
      checkAbort(c);
    }

    if (exited) {
      throw diagnosticError(new Error(`pty exited before input (code ${exitCode})`), {
        source: "pty",
        checkpoint: "before input",
        exitCode,
        stdout: transcript,
      });
    }
    try {
      ptyProcess.write(opts.input);
    } catch (e) {
      throw diagnosticError(new Error(`pty write failed: ${(e as Error).message}`), {
        source: "pty",
        checkpoint: "write",
        stdout: transcript,
      });
    }
    if (opts.submitInput !== undefined && opts.submitAfterMs !== undefined) {
      await delay(opts.submitAfterMs);
      checkCap();
      checkAborted();
      if (exited) {
        throw diagnosticError(new Error(`pty exited before input (code ${exitCode})`), {
          source: "pty",
          checkpoint: "before input",
          exitCode,
          stdout: transcript,
        });
      }
      try {
        ptyProcess.write(opts.submitInput);
      } catch (e) {
        throw diagnosticError(new Error(`pty write failed: ${(e as Error).message}`), {
          source: "pty",
          checkpoint: "write",
          stdout: transcript,
        });
      }
    }

    if (opts.completionRegex) {
      const deadline = Date.now() + opts.timeoutMs;
      let done = false;
      while (Date.now() < deadline) {
        checkCap();
        checkAborted();
        const clean = stripAnsi(transcript);
        checkAbort(clean);
        if (regexTest(opts.completionRegex, clean)) {
          done = true;
          break;
        }
        if (exited) {
          if (!regexTest(opts.completionRegex, clean)) {
            throw diagnosticError(new Error(`pty exited before completion (code ${exitCode})`), {
              source: "pty",
              checkpoint: "before completion",
              exitCode,
              stdout: transcript,
            });
          }
          done = true;
          break;
        }
        await delay(40);
      }
      if (!done) {
        await kill();
        throw diagnosticError(new Error(`pty completion timeout after ${opts.timeoutMs}ms`), {
          source: "pty",
          checkpoint: "completion timeout",
          durationMs: opts.timeoutMs,
          stdout: transcript,
        });
      }
    } else {
      const deadline = Date.now() + opts.timeoutMs;
      while (Date.now() < deadline) {
        checkCap();
        checkAborted();
        const c = stripAnsi(transcript);
        checkAbort(c);
        if (exited) break;
        await delay(40);
      }
    }

    await kill();
    checkCap();
    checkAborted();
    const finalClean = stripAnsi(transcript);
    checkAbort(finalClean);
    unregisterChild();
    teardownAbort();
    return transcript;
  } catch (e) {
    await kill();
    if (e instanceof DiagnosticError) throw e;
    throw diagnosticError(e, { source: "pty", stdout: transcript, exitCode });
  } finally {
    cleanup();
    unregisterChild();
    teardownAbort();
  }
}

export async function runPty(opts: PtyRunOptions): Promise<string> {
  try {
    if (isBunRuntime()) {
      return await runPtyBun(opts);
    }
    return await runPtyNode(opts);
  } catch (e) {
    if (e instanceof DiagnosticError) throw e;
    throw diagnosticError(e, { source: "pty" });
  }
}
