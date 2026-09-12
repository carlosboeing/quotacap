// Daemon skew detection and takeover protocol (design section 6). Shared by
// `web`, `status`, `advise`, and (Task 3) `update`: every command that
// contacts /health compares version and exec, and a CLI newer than the
// daemon restarts it instead of failing with exit code 2.
import path from "node:path";
import { VERSION } from "../version.js";
import { getDbPath } from "../config.js";
import {
  createServiceClient,
  ServiceError,
  ServiceUnavailable,
  type ServiceClient,
} from "../runtime/client.js";
import { readToken } from "../runtime/token.js";
import { readClaim, type ClaimInfo } from "../runtime/owner.js";
import { runServiceCommand, isServiceManaged } from "../service/index.js";

export type SkewKind = "match" | "exec-only" | "cli-newer" | "cli-older";

export interface HealthView {
  ok?: unknown;
  version?: unknown;
  exec?: unknown;
}

export { parseVersion, compareVersions } from "../runtime/versions.js";
import { compareVersions, parseVersion } from "../runtime/versions.js";

export function checkSkew(
  health: HealthView,
  cliVersion: string = VERSION,
  cliExec: string = process.execPath,
): SkewKind {
  const hv = typeof health.version === "string" ? health.version : "";
  const hex = typeof health.exec === "string" ? health.exec : "";
  if (compareVersions(cliVersion, hv) === 0) {
    return !hex || hex === cliExec ? "match" : "exec-only";
  }
  // Unequal versions: the CLI-newer path runs only when the CLI version
  // parses and the daemon version does not sort above it. Anything else
  // warns and proceeds; a newer daemon is never restarted into an older CLI.
  if (parseVersion(cliVersion) && compareVersions(hv, cliVersion) <= 0) {
    return "cli-newer";
  }
  return "cli-older";
}

/** Upgrade attempted but failed (restart error, readiness timeout, port never released). Callers exit 1. */
export class TakeoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TakeoverError";
  }
}

/** Daemon cannot be asked to stop (old binary, missing token). Callers print the message and exit 2. */
export class WedgedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WedgedError";
  }
}

export function olderCliWarning(daemonVersion: string): string {
  return `daemon is newer (${daemonVersion}); run 'quotacap update' to match it`;
}

export function execSkewWarning(
  daemonExec: string,
  cliVersion: string = VERSION,
  cliExec: string = process.execPath,
): string {
  return `warning: service executable (${daemonExec}) differs from this CLI (${cliExec}) but versions match (${cliVersion}); continuing`;
}

export function unmanagedSkewWarning(daemonVersion: string): string {
  return `warning: daemon is older (${daemonVersion}) and no background service is registered; showing stored readings — run 'quotacap web' to upgrade`;
}

export function upgradedMessage(oldVersion: string, cliVersion: string, via: "service" | "daemon"): string {
  return `Upgraded daemon from ${oldVersion} to ${cliVersion} (${via === "service" ? "service restarted" : "daemon restarted"})`;
}

// Recovery instructions for a daemon that cannot be reached. The tool never
// kills by PID; the human verifies first. This is the only surviving use of
// the mismatch exit code.
export function formatWedged(opts: {
  claim: ClaimInfo | null;
  port: number;
  managed: boolean;
}): string {
  const { claim, port, managed } = opts;
  if (managed) {
    return (
      `existing service mismatch: daemon on port ${port} is not answering but a background service is registered; ` +
      `run 'quotacap service restart' (or 'quotacap service stop' and retry) to recover`
    );
  }
  if (claim) {
    return (
      `existing service mismatch: installation owned by ${claim.exec} version ${claim.version} ` +
      `(pid ${claim.pid}, started ${claim.startedAt}) is not answering on port ${port}; ` +
      `stop that process in its own terminal, or verify it with 'ps -p ${claim.pid}' and then 'kill ${claim.pid}' before retrying`
    );
  }
  return (
    `existing service mismatch: daemon on port ${port} is not answering and no ownership claim was found; ` +
    `stop the process listening on port ${port} in its own terminal and retry`
  );
}

export type SleepFn = (ms: number) => Promise<void>;
export type CreateTakeoverClient = (opts: {
  port: number;
  token?: string;
  timeoutMs: number;
}) => ServiceClient;
export type ExecServiceFn = (args: string[], opts?: Record<string, any>) => Promise<number>;

const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

export interface WaitOpts {
  createClient?: CreateTakeoverClient;
  sleep?: SleepFn;
  timeoutMs?: number;
}

// Poll /health until it reports the expected version (or the deadline).
export async function waitForHealthy(
  port: number,
  expectedVersion: string,
  opts: WaitOpts = {},
): Promise<any | null> {
  const createClient = opts.createClient ?? createServiceClient;
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const deadline = Date.now() + timeoutMs;
  const client = createClient({ port, timeoutMs: 1000 });
  for (;;) {
    try {
      const h = await client.get("/health");
      if (h?.ok && h?.ready && h?.version === expectedVersion) return h;
    } catch {}
    if (Date.now() >= deadline) return null;
    await sleep(500);
  }
}

// Poll until the port stops answering AND the ownership claim is gone.
export async function waitForRelease(
  port: number,
  dataDir: string = path.dirname(getDbPath()),
  opts: WaitOpts = {},
): Promise<boolean> {
  const createClient = opts.createClient ?? createServiceClient;
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const deadline = Date.now() + timeoutMs;
  const client = createClient({ port, timeoutMs: 1000 });
  for (;;) {
    let portDown = false;
    try {
      await client.get("/health");
    } catch {
      portDown = true;
    }
    if (portDown && readClaim(dataDir) === null) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

export interface TakeoverSharedOpts extends WaitOpts {
  port: number;
  cliVersion?: string;
  cliExec?: string;
  dataDir?: string;
}

export interface ManagedTakeoverOpts extends TakeoverSharedOpts {
  health: HealthView;
  execService?: ExecServiceFn;
  // Post-update only: reinstall instead of restarting, so the supervisor
  // unit regenerates its PATH (a restart keeps the install-time PATH).
  // The expected version travels with the call because `update` runs in the
  // old binary, whose in-process VERSION would otherwise make install
  // conclude it is already up to date and never restart the daemon.
  refreshRegistration?: boolean;
}

// Managed path: restart the supervisor-owned job, wait for readiness, and
// verify /health reports the CLI version before declaring success.
export async function takeoverManaged(
  opts: ManagedTakeoverOpts,
): Promise<{ oldVersion: string; message: string }> {
  const cliVersion = opts.cliVersion ?? VERSION;
  const oldVersion =
    typeof opts.health.version === "string" && opts.health.version
      ? opts.health.version
      : "unknown";
  const execService =
    opts.execService ?? ((args, o) => runServiceCommand(args, o ?? {}, {}));
  const verb = opts.refreshRegistration ? "install" : "restart";
  const code = await execService(
    [verb],
    opts.refreshRegistration ? { version: cliVersion } : undefined,
  );
  if (code !== 0) {
    throw new TakeoverError(`daemon upgrade failed: service ${verb} exited ${code}`);
  }
  const healthy = await waitForHealthy(opts.port, cliVersion, opts);
  if (!healthy) {
    throw new TakeoverError(
      `daemon upgrade failed: service did not report version ${cliVersion} within 15s; run 'quotacap service status' to inspect`,
    );
  }
  return { oldVersion, message: upgradedMessage(oldVersion, cliVersion, "service") };
}

export interface UnmanagedTakeoverOpts extends TakeoverSharedOpts {
  health: HealthView;
  readToken?: () => string | undefined;
}

// Unmanaged path: ask the reachable daemon to stop gracefully, then wait for
// the port and claim to release. The caller spawns the successor (or, for
// `update`, leaves it stopped with guidance).
export async function takeoverUnmanaged(
  opts: UnmanagedTakeoverOpts,
): Promise<{ oldVersion: string }> {
  const port = opts.port;
  const cliVersion = opts.cliVersion ?? VERSION;
  const cliExec = opts.cliExec ?? process.execPath;
  const dataDir = opts.dataDir ?? path.dirname(getDbPath());
  const oldVersion =
    typeof opts.health.version === "string" && opts.health.version
      ? opts.health.version
      : "unknown";
  const token = (opts.readToken ?? readToken)();
  if (!token) {
    throw new WedgedError(formatWedged({ claim: readClaim(dataDir), port, managed: false }));
  }
  const createClient = opts.createClient ?? createServiceClient;
  const client = createClient({ port, token, timeoutMs: 5000 });
  try {
    // Always send the info body: Fastify rejects content-type json with an
    // empty body, and the daemon logs the requester.
    await client.post("/api/restart", { version: cliVersion, exec: cliExec });
  } catch (e) {
    if (e instanceof ServiceError && e.status === 404) {
      // Old daemon predates /api/restart and cannot be asked to stop.
      throw new WedgedError(formatWedged({ claim: readClaim(dataDir), port, managed: false }));
    }
    if (e instanceof ServiceError && e.status === 401) {
      throw new TakeoverError(`daemon upgrade failed: restart rejected (401) on port ${port}`);
    }
    if (e instanceof ServiceError) {
      throw new TakeoverError(`daemon upgrade failed: restart request failed (HTTP ${e.status}) on port ${port}`);
    }
    if (!(e instanceof ServiceUnavailable)) throw e;
    // Connection failed: the daemon may already be stopping; fall through
    // to the release wait, which succeeds fast when it is gone.
  }
  const released = await waitForRelease(port, dataDir, opts);
  if (!released) {
    throw new TakeoverError(
      `daemon upgrade failed: old daemon did not stop within 15s; stop the process on port ${port} in its own terminal and retry`,
    );
  }
  return { oldVersion };
}

export { isServiceManaged };
