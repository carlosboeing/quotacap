// Thin delegate: the runtime owns polling, HTTP and storage.
import path from "node:path";
import { getDbPath } from "./config.js";
import { readClaim } from "./runtime/owner.js";

export {
  startService as startDaemon,
  startService as start,
  resolveClaudeExecPath,
  AlreadyRunningError,
} from "./runtime/service.js";
export type {
  StartServiceOptions as StartDaemonOptions,
  ServiceHandle,
  ServiceState,
} from "./runtime/service.js";
export {
  ensureToken as ensureDaemonToken,
  readToken as readDaemonToken,
  tokenFile,
} from "./runtime/token.js";

// Claim-based single-instance check. The pidfile logic is deleted with D1:
// PID liveness is never proof of identity, and the `ps` command match for
// recycled pids is gone with it. A fresh heartbeat (<30s) means running.
export function isDaemonRunning(dataDir = path.dirname(getDbPath())): boolean {
  const c = readClaim(dataDir);
  if (!c) return false;
  return Date.now() - new Date(c.lastBeat).getTime() < 30000;
}

// Kept for the current /api/refresh route until Task 5 delegates refresh to
// the coordinator.
export async function pollOnce(db: any, enabled: string[]) {
  const { pollAll } = await import("./adapters/index.js");
  const { upsertQuota } = await import("./store/quotas.js");
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
