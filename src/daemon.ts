import { pollAll } from "./adapters/index.js";
import { upsertQuota } from "./store/quotas.js";
import { getDbPath, readConfig } from "./config.js";
import { openDb, migrate } from "./store/db.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function pidFile(): string {
  return path.join(path.dirname(getDbPath()), "daemon.pid");
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

export async function pollOnce(db:any, enabled:string[]){
  const results = await pollAll(enabled);
  for(const r of results){
    if((r as any).status==="fulfilled" && (r as any).value) upsertQuota(db, (r as any).value);
    else if((r as any).status==="rejected") console.warn(`[quotacap] poll ${(r as any).provider} failed: ${String((r as any).reason?.message ?? (r as any).reason)}`);
    // skipped (e.g. manual) is not a failure — no warning, not degraded
  }
  return results;
}

export async function startDaemon(){
  if (isDaemonRunning()) {
    const existing = fs.readFileSync(pidFile(), "utf8").trim();
    return { alreadyRunning: existing, db: null as any, timer: null as any, stop: () => {} };
  }
  const dbDir = path.dirname(getDbPath());
  fs.mkdirSync(dbDir, { recursive: true });
  const db = openDb(getDbPath());
  migrate(db);
  fs.mkdirSync(path.dirname(pidFile()), { recursive: true });
  fs.writeFileSync(pidFile(), String(process.pid));
  const cfg = await readConfig();
  const intervalMs = (cfg.pollMinutes ?? 15) * 60 * 1000;
  // initial poll (fire-and-forget, don't block start)
  pollOnce(db, cfg.enabledProviders).catch(e=>console.warn("[quotacap] initial poll failed", e?.message ?? String(e)));
  const jitter = Math.floor(Math.random() * 5000);
  const timer = setInterval(()=> { pollOnce(db, cfg.enabledProviders).catch(e=>console.warn("[quotacap] interval poll failed", e?.message ?? String(e))); }, intervalMs + jitter);
  const stop = () => {
    clearInterval(timer);
    try { fs.rmSync(pidFile(), { force: true }); } catch {}
  };
  return { db, timer, alreadyRunning: undefined as string | undefined, stop };
}

// alias for plan's daemon.start() naming
export const start = startDaemon;