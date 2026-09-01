import * as pty from "node-pty";

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
  timeoutMs: number;
  maxBytes?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function regexTest(re: RegExp, s: string): boolean {
  // avoid global lastIndex pitfalls
  const fresh = new RegExp(re.source, re.flags.replace("g", ""));
  return fresh.test(s);
}

export async function runPty(opts: PtyRunOptions): Promise<string> {
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const cols = opts.cols ?? 140;
  const rows = opts.rows ?? 50;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 6000;
  if (opts.timeoutMs <= 0) throw new Error("pty: timeoutMs must be > 0");

  let transcript = "";
  let exited = false;
  let exitCode: number | undefined;

  let ptyProcess: pty.IPty;
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

  const disposables: pty.IDisposable[] = [];
  disposables.push(
    ptyProcess.onData((data: string) => {
      transcript += data;
    }),
  );
  disposables.push(
    ptyProcess.onExit(({ exitCode: c }) => {
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

  try {
    if (opts.readyRegex) {
      const deadline = Date.now() + readyTimeoutMs;
      let matched = false;
      let trustHandled = false;
      while (Date.now() < deadline) {
        checkCap();
        if (exited) throw new Error(`pty exited before ready (code ${exitCode})`);
        const clean = stripAnsi(transcript);
        if (regexTest(opts.readyRegex, clean)) {
          matched = true;
          break;
        }
        if (!trustHandled && /Trust this folder\?/i.test(clean)) {
          trustHandled = true;
          try {
            ptyProcess.write("\x1b[A");
            await delay(120);
            ptyProcess.write("\r");
            await delay(400);
          } catch {}
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
    } else if (opts.settleDelayMs) {
      await delay(opts.settleDelayMs);
      checkCap();
      if (exited) throw new Error(`pty exited during settle (code ${exitCode})`);
    }

    if (exited) throw new Error(`pty exited before input (code ${exitCode})`);
    ptyProcess.write(opts.input);

    if (opts.completionRegex) {
      const deadline = Date.now() + opts.timeoutMs;
      let done = false;
      while (Date.now() < deadline) {
        checkCap();
        if (regexTest(opts.completionRegex, stripAnsi(transcript))) {
          done = true;
          break;
        }
        if (exited) {
          if (!regexTest(opts.completionRegex, stripAnsi(transcript))) {
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
        if (exited) break;
        await delay(40);
      }
    }

    await kill();
    checkCap();
    return transcript;
  } catch (e) {
    await kill();
    throw e;
  } finally {
    cleanup();
  }
}
