import { claudeAdapter } from "./claude.js";
import { manualAdapter } from "./manual.js";
import { codexAdapter } from "./codex.js";
import { kimiAdapter } from "./kimi.js";
import { grokAdapter } from "./grok.js";
import { agyAdapter } from "./agy.js";
import { museAdapter } from "./muse.js";
import { opencodeGoAdapter } from "./opencode-go.js";
import { installAdapterSignal, clearAdapterSignal } from "../runtime/spawn.js";
import { classifyFailure } from "../diagnostics/failure.js";
import type { Adapter } from "./types.js";
export const adapters: Record<string, Adapter> = {
  claude: claudeAdapter,
  manual: manualAdapter as unknown as Adapter,
  codex: codexAdapter,
  kimi: kimiAdapter,
  grok: grokAdapter,
  agy: agyAdapter,
  muse: museAdapter,
  "opencode-go": opencodeGoAdapter,
};
// Kept in sync with the per-adapter spawn/PTY timeouts: claude.ts exec 15s,
// codex/grok/kimi/muse runPty timeouts match their entries here. The gate is
// the outer bound; the inner spawn timeout should fire first.
export const ADAPTER_TIMEOUTS: Record<string, number> = {
  claude: 15000,
  codex: 12000,
  kimi: 8000,
  grok: 14000,
  agy: 20000,
  muse: 90000,
  "opencode-go": 8000,
};

export interface PollAllOptions {
  timeouts?: Record<string, number>;
  /** Max concurrent adapter polls. Default 3: seven heavy CLI/TUI spawns at
   * once starve each other into timeouts. */
  maxConcurrency?: number;
  /** Attempts per adapter including the first. Default 3.
   * 1 disables retry. */
  maxAttempts?: number;
  /** Backoff base between attempts: the delay after failed attempt n is
   * min(cap, base * 2^(n-1)) with equal jitter. Default 2000. */
  baseRetryDelayMs?: number;
  /** Backoff ceiling. Default 8000. */
  maxRetryDelayMs?: number;
  /** When aborted, in-flight attempts run out but no retry is started. */
  signal?: AbortSignal;
}

/**
 * Exponential backoff with equal jitter: half the exponential delay plus a
 * uniform random half, so concurrent adapters do not retry in lockstep.
 * failedAttempt is 1-based (1 = the first attempt just failed).
 */
export function computeRetryDelayMs(
  failedAttempt: number,
  baseMs = 2000,
  capMs = 8000,
  rng: () => number = Math.random,
): number {
  const base = Math.max(0, baseMs);
  const cap = Math.max(0, capMs);
  const exp = Math.min(cap, base * 2 ** Math.max(0, failedAttempt - 1));
  return Math.floor(exp / 2 + rng() * (exp / 2));
}

/** Order-preserving concurrency-limited map. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = new Array(Math.min(Math.max(1, limit), items.length))
    .fill(null)
    .map(async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    });
  await Promise.all(workers);
  return results;
}

// A child that ran and produced a diagnosable output problem is worth more
// attempts; a login wall, missing binary, trust prompt, or rate limit will
// not clear on retry, and a mid-flight child death (killAll, crash) must
// never respawn — especially during shutdown. Shared with the coordinator,
// which consults it for both in-generation retries and recovery polls.
export const RETRYABLE_DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
  "parse_error",
  "network",
  "service_unavailable",
]);

export function isRetryableChildFailure(reason: unknown): boolean {
  return RETRYABLE_DIAGNOSTIC_CODES.has(classifyFailure("Provider", reason).diagnosticCode);
}

interface GateOutcome {
  ok: boolean;
  value?: unknown;
  reason?: unknown;
  /** True only when our own gate timer fired (not on child failure). */
  timedOut: boolean;
}

async function pollOnceWithGate(id: string, adapter: Adapter, timeout: number): Promise<GateOutcome> {
  // One controller per attempt: a timeout aborts only that attempt's
  // children; the signal clears when the attempt settles.
  const controller = new AbortController();
  installAdapterSignal(id, controller.signal);
  let p: Promise<unknown>;
  try {
    p = Promise.resolve(adapter.poll());
  } catch (e) {
    clearAdapterSignal(id);
    return { ok: false, reason: e, timedOut: false };
  }
  // Identity-tagged: only this exact instance means our gate fired, never a
  // child error that happens to mention timeouts.
  const gateError = new Error(`timeout after ${timeout}ms`);
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          controller.abort();
        } catch {}
        reject(gateError);
      }, timeout);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
    return { ok: true, value, timedOut: false };
  } catch (e) {
    return { ok: false, reason: e, timedOut: e === gateError };
  } finally {
    clearAdapterSignal(id);
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function pollAll(enabled: string[], opts?: PollAllOptions) {
  const maxConcurrency = opts?.maxConcurrency ?? 3;
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? 3);
  const baseRetryDelayMs = opts?.baseRetryDelayMs ?? 2000;
  const maxRetryDelayMs = opts?.maxRetryDelayMs ?? 8000;
  const runOne = async (id: string) => {
    const a = adapters[id];
    if (!a) return { provider: id, status: "rejected" as const, reason: new Error(`unknown adapter ${id}`) };
    // manual adapter has no poll capability — skip without degraded
    if (id === "manual") return { provider: id, status: "skipped" as const, reason: new Error("manual skipped") };
    const timeout = opts?.timeouts?.[id] ?? ADAPTER_TIMEOUTS[id] ?? 8000;
    let lastReason: unknown = new Error(`${id}: poll produced no result`);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1 && opts?.signal?.aborted) break;
      const outcome = await pollOnceWithGate(id, a, timeout);
      if (outcome.ok) return { provider: id, status: "fulfilled" as const, value: outcome.value };
      lastReason = outcome.reason;
      if (attempt >= maxAttempts || opts?.signal?.aborted) break;
      // Our own gate firing means transient slowness: always retry. A child
      // failure retries only for output problems, never for deaths.
      const retry = outcome.timedOut || isRetryableChildFailure(outcome.reason);
      if (!retry) break;
      await delay(computeRetryDelayMs(attempt, baseRetryDelayMs, maxRetryDelayMs));
    }
    return { provider: id, status: "rejected" as const, reason: lastReason };
  };
  return mapWithConcurrency(enabled, maxConcurrency, runOne);
}
