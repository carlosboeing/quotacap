// Tracked child spawning with a per-adapter abort context (decision D2).
// Adapter.poll() signatures stay unchanged: the registry installs one
// AbortController per adapter id before invoking poll(); tracked exec/PTY
// wrappers read the controller for their adapter id.
//
// Every probe runs in its own process group (detached) with stdin closed,
// a bounded timeout, and SIGTERM → SIGKILL escalation delivered to the
// whole group — so a hung CLI and the grandchildren it booted (MCP servers)
// can never outlive the probe. execFile cannot do this: it forwards neither
// `detached` nor `stdio`, its timeout sends one SIGTERM with no escalation,
// and its callback never fires while a SIGTERM-ignoring child lives, so the
// probe promise pends forever. Hence the spawn-based implementation below.
import { spawn, type ChildProcess } from "node:child_process";
import { diagnosticError } from "../diagnostics/failure.js";

/** Fallback bound when a probe passes no timeout. Every production caller
 * passes its own (8–20s); this only binds ad-hoc callers. */
export const DEFAULT_PROBE_TIMEOUT_MS = 30000;

/** SIGTERM → SIGKILL escalation delay for a probe that ignores SIGTERM. */
const PROBE_ESCALATE_MS = 1000;

/** execFile parity: default cap on captured stdout/stderr each. */
const DEFAULT_MAX_BUFFER = 1024 * 1024;

/** Kill the probe's whole process group (it leads its group via detached).
 * Falls back to a direct kill where group kill is unsupported (Windows) or
 * the group is already gone. Never throws. */
function killProbeGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {}
  }
  try {
    child.kill(signal);
  } catch {}
}

const installed = new Map<string, AbortSignal>();

export function installAdapterSignal(id: string, signal: AbortSignal): void {
  installed.set(id, signal);
}

export function clearAdapterSignal(id: string): void {
  installed.delete(id);
}

export function adapterSignal(id: string): AbortSignal | undefined {
  return installed.get(id);
}

interface TrackedChild {
  kill: (signal?: NodeJS.Signals) => void;
  label: string;
}

const tracked = new Set<TrackedChild>();

export function registerTrackedChild(
  kill: (signal?: NodeJS.Signals) => void,
  label = "",
): () => void {
  const entry: TrackedChild = { kill, label };
  tracked.add(entry);
  return () => {
    tracked.delete(entry);
  };
}

export function liveChildCount(): number {
  return tracked.size;
}

export function killAll(signal: NodeJS.Signals = "SIGTERM", escalateMs = 1000): void {
  // Snapshot: escalation only ever touches the generation alive at call
  // time, never children spawned afterwards.
  const targets = [...tracked];
  for (const entry of targets) {
    try {
      entry.kill(signal);
    } catch {}
  }
  if (escalateMs > 0 && targets.length > 0) {
    // Survivors (still registered = still alive) get SIGKILL.
    const t = setTimeout(() => {
      for (const entry of targets) {
        if (!tracked.has(entry)) continue;
        try {
          entry.kill("SIGKILL");
        } catch {}
      }
    }, escalateMs);
    if (typeof (t as any).unref === "function") (t as any).unref();
  }
}

export interface TrackedExecOptions {
  /** Bound in ms; defaults to DEFAULT_PROBE_TIMEOUT_MS. On expiry the whole
   * process group gets SIGTERM (SIGKILL escalation after 1s) and the promise
   * rejects promptly without waiting for the child to exit. */
  timeout?: number;
  maxBuffer?: number;
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

function abortError(adapterId: string): Error {
  const e = new Error(`${adapterId}: aborted`);
  e.name = "AbortError";
  return e;
}

export function trackedExecFile(
  adapterId: string,
  file: string,
  args: string[],
  opts?: TrackedExecOptions,
): Promise<{ stdout: string; stderr: string }> {
  const signal = opts?.signal ?? adapterSignal(adapterId);
  if (signal?.aborted) return Promise.reject(diagnosticError(abortError(adapterId), { source: "exec", checkpoint: "abort" }));
  return new Promise((resolve, reject) => {
    const timeoutMs = opts?.timeout ?? DEFAULT_PROBE_TIMEOUT_MS;
    const maxBuffer = opts?.maxBuffer ?? DEFAULT_MAX_BUFFER;
    let settled = false;
    let stdout = "";
    let stderr = "";
    let stdoutLen = 0;
    let stderrLen = 0;

    const child = spawn(file, args ?? [], {
      cwd: opts?.cwd,
      env: opts?.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const cleanup = () => {
      clearTimeout(timer);
      // The escalation timer is NOT cleared here: on the timeout path the
      // promise settles promptly while the child may still be alive, and
      // the SIGKILL must still land. It is cleared in close (child dead).
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const settleResolve = (v: { stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(v);
    };
    const settleReject = (e: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    };

    const unregister = registerTrackedChild((sig) => {
      killProbeGroup(child, sig ?? "SIGTERM");
    }, adapterId);

    let escalateTimer: ReturnType<typeof setTimeout> | undefined;
    const armEscalation = () => {
      if (escalateTimer !== undefined) return;
      escalateTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) {
            killProbeGroup(child, "SIGKILL");
          }
        } catch {}
      }, PROBE_ESCALATE_MS);
      if (typeof (escalateTimer as any).unref === "function") (escalateTimer as any).unref();
    };

    const timer = setTimeout(() => {
      killProbeGroup(child, "SIGTERM");
      armEscalation();
      // Reject promptly: unlike execFile, never wait for a SIGTERM-ignoring
      // child to exit before settling. The tracked entry stays until the
      // child actually dies, so killAll still reaches stragglers.
      settleReject(
        diagnosticError(new Error(`${adapterId}: probe timed out after ${timeoutMs}ms`), {
          source: "exec",
        }),
      );
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      killProbeGroup(child, "SIGTERM");
      armEscalation();
      // Settles in the close handler with the abort checkpoint.
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const onOverflow = (kind: string) => {
      killProbeGroup(child, "SIGTERM");
      armEscalation();
      settleReject(
        diagnosticError(new Error(`${kind} maxBuffer length exceeded`), {
          source: "exec",
          stdout,
          stderr,
        }),
      );
    };
    child.stdout?.on("data", (d) => {
      if (settled) return;
      stdoutLen += d.length;
      if (stdoutLen > maxBuffer) {
        onOverflow("stdout");
        return;
      }
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      if (settled) return;
      stderrLen += d.length;
      if (stderrLen > maxBuffer) {
        onOverflow("stderr");
        return;
      }
      stderr += d.toString();
    });
    child.on("error", (err) => {
      // Spawn failure (e.g. ENOENT): no child will ever run. Unregister
      // now (close still fires later; unregister is idempotent) so the
      // entry is gone by the time the rejection is observed.
      unregister();
      settleReject(diagnosticError(err, { source: "exec", stdout, stderr }));
    });
    child.on("close", (code) => {
      unregister();
      clearTimeout(escalateTimer);
      if (settled) return;
      if (signal?.aborted) {
        settleReject(
          diagnosticError(abortError(adapterId), {
            source: "exec",
            checkpoint: "abort",
            stdout,
            stderr,
          }),
        );
      } else if (code === 0) {
        settleResolve({ stdout, stderr });
      } else {
        const err: any = new Error(`Command failed: ${file}${code === null ? "" : ` (code ${code})`}`);
        if (typeof code === "number") err.code = code;
        settleReject(
          diagnosticError(err, {
            source: "exec",
            exitCode: code ?? undefined,
            stderr,
            stdout,
          }),
        );
      }
    });
  });
}
