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
