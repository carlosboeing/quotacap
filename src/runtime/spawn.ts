// Tracked child spawning with a per-adapter abort context (decision D2).
// Adapter.poll() signatures stay unchanged: the registry installs one
// AbortController per adapter id before invoking poll(); tracked exec/PTY
// wrappers read the controller for their adapter id.
import { execFile } from "node:child_process";
import { diagnosticError } from "../diagnostics/failure.js";

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
    const { signal: _drop, ...execOpts } = opts ?? {};
    const child = execFile(file, args ?? [], execOpts, (err, stdout, stderr) => {
      unregister();
      if (signal) signal.removeEventListener("abort", onAbort);
      if (err) {
        const exitCode = typeof (err as any).code === "number" ? (err as any).code : undefined;
        reject(
          diagnosticError(err, {
            source: "exec",
            checkpoint: signal?.aborted ? "abort" : undefined,
            exitCode,
            stderr: stderr as string,
            stdout: stdout as string,
          }),
        );
      } else {
        resolve({ stdout: stdout as string, stderr: stderr as string });
      }
    });
    const unregister = registerTrackedChild((sig) => {
      try {
        child.kill(sig ?? "SIGTERM");
      } catch {}
    }, adapterId);
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {}
      const t = setTimeout(() => {
        try {
          if (child.exitCode === null) child.kill("SIGKILL");
        } catch {}
      }, 1000);
      if (typeof (t as any).unref === "function") (t as any).unref();
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}
