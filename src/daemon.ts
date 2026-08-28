import { pollAll } from "./adapters/index.js";
import { upsertQuota } from "./store/quotas.js";

export async function pollOnce(db:any, enabled:string[]){
  const results = await pollAll(enabled);
  for(const r of results){ if((r as any).status==="fulfilled" && (r as any).value) upsertQuota(db, (r as any).value); }
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
  pollOnce(db, cfg.enabledProviders).catch(()=>{});
  const jitter = Math.floor(Math.random() * 5000);
  const timer = setInterval(()=> { pollOnce(db, cfg.enabledProviders).catch(()=>{}); }, intervalMs + jitter);
  // allow process to exit if only timer remains
  if ((timer as any).unref) (timer as any).unref();
  return { db, timer, stop: () => clearInterval(timer) };
}

// alias for plan's daemon.start() naming
export const start = startDaemon;
