import { pollAll } from "./adapters/index.js";
import { upsertQuota } from "./store/quotas.js";

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
  const { getDbPath, readConfig } = await import("./config.js");
  const { openDb, migrate } = await import("./store/db.js");
  const db = openDb(getDbPath());
  migrate(db);
  const cfg = await readConfig();
  const intervalMs = (cfg.pollMinutes ?? 15) * 60 * 1000;
  // initial poll (fire-and-forget, don't block start)
  pollOnce(db, cfg.enabledProviders).catch(e=>console.warn("[quotacap] initial poll failed", e?.message ?? String(e)));
  const jitter = Math.floor(Math.random() * 5000);
  const timer = setInterval(()=> { pollOnce(db, cfg.enabledProviders).catch(e=>console.warn("[quotacap] interval poll failed", e?.message ?? String(e))); }, intervalMs + jitter);
  // keep event loop alive — this is the only long-lived process per design
  // (previous unref() caused immediate exit after the initial poll)
  return { db, timer, stop: () => clearInterval(timer) };
}

// alias for plan's daemon.start() naming
export const start = startDaemon;
