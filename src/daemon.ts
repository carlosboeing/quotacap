import { pollAll } from "./adapters/index.js";
import { claudeAdapter } from "./adapters/claude.js";
import { upsertQuota } from "./store/quotas.js";
import { getDbPath, readConfig } from "./config.js";
import { openDb, migrate } from "./store/db.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function pidFile(): string {
  return path.join(path.dirname(getDbPath()), "daemon.pid");
}

export function resolveClaudeExecPath(): string | undefined {
  try {
    const resolved = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
    return resolved.length > 0 ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err.code === "EPERM") return true;
    return false;
  }
}

function acquirePidFile(file: string, exit: (code: number) => void): boolean {
  try { const d=path.dirname(file); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try{fs.chmodSync(d,0o700);}catch{} } catch {}
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644);
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      return true;
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;

      let existingPid: number | undefined;
      try {
        const content = fs.readFileSync(file, "utf8").trim();
        const parsed = parseInt(content, 10);
        if (Number.isInteger(parsed) && parsed > 0) {
          existingPid = parsed;
        }
      } catch {
        // file could not be read or was removed
      }

      if (existingPid && isPidAlive(existingPid)) {
        console.error(`daemon already running (pid ${existingPid})`);
        exit(1);
        return false;
      }

      // Stale pidfile (dead pid or unreadable/invalid). Steal it.
      try {
        fs.rmSync(file, { force: true });
      } catch (rmErr: any) {
        if (rmErr.code !== "ENOENT") throw rmErr;
      }
    }
  }
  console.error("daemon already running or unable to acquire pidfile");
  exit(1);
  return false;
}

// True when the pidfile names a live process that still runs quotacap — the
// command check keeps a recycled pid from being mistaken for a running daemon
// and matches both the compiled binary and `node dist/cli/index.js`.
export function isDaemonRunning(file = pidFile()): boolean {
  try {
    const pid = parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
    return cmd.includes("quotacap") || cmd.includes("cli/index.js");
  } catch {
    return false;
  }
}

export async function pollOnce(db: any, enabled: string[]) {
  const results = await pollAll(enabled);
  for (const r of results) {
    if ((r as any).status === "fulfilled" && (r as any).value) {
      const val = (r as any).value;
      if (Array.isArray(val)) {
        for (const q of val) upsertQuota(db, q);
      } else {
        upsertQuota(db, val);
      }
    } else if ((r as any).status === "rejected") {
      console.warn(`[quotacap] poll ${(r as any).provider} failed: ${String((r as any).reason?.message ?? (r as any).reason)}`);
    }
    // skipped (e.g. manual) is not a failure — no warning, not degraded
  }
  return results;
}

export interface StartDaemonOptions {
  exit?: (code: number) => void;
  resolveClaude?: () => string | undefined;
  pidFile?: string;
}

export async function startDaemon(opts?: StartDaemonOptions) {
  const exit = opts?.exit ?? process.exit;
  const file = opts?.pidFile ?? pidFile();

  if (!acquirePidFile(file, exit)) {
    let existing: string | undefined;
    try { existing = fs.readFileSync(file, "utf8").trim(); } catch {}
    return { alreadyRunning: existing || "running", db: null as any, timer: null as any, stop: () => {} };
  }

  const resolver = opts?.resolveClaude ?? resolveClaudeExecPath;
  const claudePath = resolver();
  if (claudePath) {
    claudeAdapter.execPath = claudePath;
  }

  const dbDir = path.dirname(getDbPath());
  try { fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 }); try{fs.chmodSync(dbDir,0o700);}catch{} } catch {}
  const db = openDb(getDbPath());
  migrate(db);

  const cfg = await readConfig();
  const intervalMs = (cfg.pollMinutes ?? 15) * 60 * 1000;
  // initial poll (fire-and-forget, don't block start)
  pollOnce(db, cfg.enabledProviders).catch(e => console.warn("[quotacap] initial poll failed", e?.message ?? String(e)));
  const jitter = Math.floor(Math.random() * 5000);
  const timer = setInterval(() => { pollOnce(db, cfg.enabledProviders).catch(e => console.warn("[quotacap] interval poll failed", e?.message ?? String(e))); }, intervalMs + jitter);
  const stop = () => {
    clearInterval(timer);
    try { fs.rmSync(file, { force: true }); } catch {}
  };
  return { db, timer, alreadyRunning: undefined as string | undefined, stop };
}

// alias for plan's daemon.start() naming
export const start = startDaemon;