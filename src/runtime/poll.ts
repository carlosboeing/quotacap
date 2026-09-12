// Poll coordinator: scheduled and manual refresh share one in-flight poll
// with a completion-measured cooldown (decisions D3/D4).
import { pollAll } from "../adapters/index.js";
import { upsertQuota } from "../store/quotas.js";
import {
  recordAttempt,
  getAttempt,
  type FailureCategory,
} from "../store/attempts.js";
import {
  classifyFailure,
  type DiagnosticCode,
} from "../diagnostics/failure.js";

export class ServiceClosing extends Error {
  constructor(message = "service is closing") {
    super(message);
    this.name = "ServiceClosing";
  }
}

export interface PollRow {
  provider: string;
  status: "fulfilled" | "rejected" | "skipped";
  value?: any;
  reason?: unknown;
}

export type PollFn = (enabled: string[]) => Promise<PollRow[]>;

export interface RejectedAttempt {
  provider: string;
  reason: string;
  category: Exclude<FailureCategory, null | "skipped">;
  diagnosticCode: DiagnosticCode;
  summary: string;
  action: string;
  errorDetail: string;
  error: string;
}

export interface RefreshResult {
  fulfilled: any[];
  rejected: RejectedAttempt[];
  lastPollAt: string;
  results: PollRow[];
  degraded: boolean;
  shared: boolean;
  cooldown: boolean;
}

export interface CoordinatorState {
  polling: "idle" | "in-progress" | "cooldown";
  lastCompletedPollAt: string | null;
  lastResult: RefreshResult | null;
}

export interface CoordinatorOptions {
  db: any;
  enabledProviders: string[];
  pollFn?: PollFn;
  now?: () => number;
  cooldownMs?: number;
  ownershipVerify?: () => boolean;
  onOwnershipLost?: () => void;
  /** Fired after each scheduled tick settles (success or failure). The daemon refreshes its daily update cache here. */
  onSettled?: () => void;
}

export interface Coordinator {
  refresh(): Promise<RefreshResult>;
  scheduledTick(): Promise<void>;
  start(intervalMs: number): void;
  stop(): void;
  getState(): CoordinatorState;
  setClosing(): void;
  isClosing(): boolean;
}

function defaultPollFn(enabled: string[]): Promise<PollRow[]> {
  return pollAll(enabled) as Promise<PollRow[]>;
}

export function mapFailureCategory(reason: unknown): Exclude<FailureCategory, null> {
  return classifyFailure("Provider", reason).category;
}

export function createCoordinator(opts: CoordinatorOptions): Coordinator {
  const db = opts.db;
  const enabledProviders = opts.enabledProviders;
  const pollFn = opts.pollFn ?? defaultPollFn;
  const now = opts.now ?? Date.now;
  const cooldownMs = opts.cooldownMs ?? 60000;
  const ownershipVerify = opts.ownershipVerify;
  const onOwnershipLost = opts.onOwnershipLost ?? (() => process.exit(1));
  const onSettled = opts.onSettled;

  let inFlight: Promise<RefreshResult> | null = null;
  let lastResult: RefreshResult | null = null;
  let lastCompletedPollAt: string | null = null;
  let completedAtMs = 0;
  let closing = false;
  let started = false;
  let intervalMs = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function arm() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void scheduledTick().catch((e) => {
        const detail = classifyFailure("all", e).errorDetail;
        console.warn("[quotacap] scheduled poll failed", detail);
      });
    }, intervalMs);
  }

  async function runGeneration(): Promise<RefreshResult> {
    const attemptedAt = new Date(now()).toISOString();
    const rows = await pollFn(enabledProviders);
    const completedAt = new Date(now()).toISOString();
    // Self-fence before any poll write (decision D1).
    if (ownershipVerify && !ownershipVerify()) {
      closing = true;
      onOwnershipLost();
      throw new ServiceClosing("ownership lost");
    }

    const fulfilled = rows
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value);

    const rejected: RejectedAttempt[] = [];
    const sanitizedResults: PollRow[] = [];
    const diagnosisMap = new Map<string, ReturnType<typeof classifyFailure>>();

    for (const r of rows) {
      if (r.status === "rejected") {
        const diagnosis = classifyFailure(r.provider, r.reason);
        diagnosisMap.set(r.provider, diagnosis);
        sanitizedResults.push({
          provider: r.provider,
          status: "rejected",
          reason: diagnosis.errorDetail,
        });
        rejected.push({
          provider: r.provider,
          reason: diagnosis.errorDetail,
          category: diagnosis.category,
          diagnosticCode: diagnosis.diagnosticCode,
          summary: diagnosis.summary,
          action: diagnosis.action,
          errorDetail: diagnosis.errorDetail,
          error: diagnosis.errorDetail,
        });
      } else {
        sanitizedResults.push(r);
      }
    }

    const result: RefreshResult = {
      fulfilled,
      rejected,
      lastPollAt: completedAt,
      results: sanitizedResults,
      degraded: rejected.length > 0,
      shared: false,
      cooldown: false,
    };
    if (closing) return result;

    for (const row of rows) {
      if (row.status === "fulfilled") {
        upsertQuota(db, row.value);
        recordAttempt(db, {
          provider: row.provider,
          attemptedAt,
          completedAt,
          succeededAt: completedAt,
          success: true,
          failureCategory: null,
        });
        const usedPct = row.value?.usedPct;
        const pctSuffix =
          typeof usedPct === "number" && Number.isFinite(usedPct)
            ? ` (${usedPct}% used)`
            : "";
        console.log(`[${completedAt}] [quotacap] [${row.provider}] poll succeeded${pctSuffix}`);
      } else if (row.status === "skipped") {
        recordAttempt(db, {
          provider: row.provider,
          attemptedAt,
          completedAt,
          succeededAt: null,
          success: true,
          failureCategory: "skipped",
        });
        console.log(`[${completedAt}] [quotacap] [${row.provider}] poll skipped`);
      } else {
        const diagnosis =
          diagnosisMap.get(row.provider) ?? classifyFailure(row.provider, row.reason);
        const prev = getAttempt(db, row.provider);
        recordAttempt(db, {
          provider: row.provider,
          attemptedAt,
          completedAt,
          succeededAt: prev?.succeededAt ?? null,
          success: false,
          failureCategory: diagnosis.category,
          diagnosticCode: diagnosis.diagnosticCode,
          summary: diagnosis.summary,
          action: diagnosis.action,
          errorDetail: diagnosis.errorDetail,
        });
        console.log(
          `[${completedAt}] [quotacap] [${row.provider}] poll failed (${diagnosis.diagnosticCode}): ${diagnosis.summary}: ${diagnosis.errorDetail}`,
        );
      }
    }
    lastResult = result;
    lastCompletedPollAt = completedAt;
    completedAtMs = new Date(completedAt).getTime();
    return result;
  }

  function launch(): Promise<RefreshResult> {
    // Gate first: inFlight is set before pollFn runs, so getState()
    // reports in-progress from inside the poll itself.
    let resolve!: (r: RefreshResult) => void;
    let reject!: (e: unknown) => void;
    const gate = new Promise<RefreshResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    inFlight = gate;
    const clear = () => {
      if (inFlight === gate) inFlight = null;
    };
    gate.then(clear, clear);
    runGeneration().then(resolve, reject);
    return gate;
  }

  function refresh(): Promise<RefreshResult> {
    if (closing) return Promise.reject(new ServiceClosing());
    if (inFlight) return inFlight.then((r) => ({ ...r, shared: true }));
    if (lastResult && now() - completedAtMs < cooldownMs) {
      return Promise.resolve({ ...lastResult, cooldown: true, shared: false });
    }
    return launch();
  }

  async function scheduledTick(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (closing) return;
    // Self-fence on each timer wake (decision D1).
    if (ownershipVerify && !ownershipVerify()) {
      closing = true;
      onOwnershipLost();
      return;
    }
    try {
      await (inFlight ?? launch());
    } catch (e: any) {
      // A discarded failure leaves lastCompletedPollAt unchanged with no
      // diagnostic, so repeated failures serve stale data and say nothing.
      const detail = classifyFailure("all", e).errorDetail;
      console.warn(
        "[quotacap] scheduled poll failed",
        detail,
      );
    } finally {
      // Rearming stays outside the failure path: one bad generation must not
      // end the schedule.
      if (!closing && started) arm();
      if (!closing) {
        try {
          onSettled?.();
        } catch {}
      }
    }
  }

  function start(ms: number): void {
    started = true;
    intervalMs = ms;
    arm();
  }

  function stop(): void {
    started = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function getState(): CoordinatorState {
    const polling =
      inFlight !== null
        ? "in-progress"
        : lastCompletedPollAt !== null && now() - completedAtMs < cooldownMs
          ? "cooldown"
          : "idle";
    return { polling, lastCompletedPollAt, lastResult };
  }

  function setClosing(): void {
    closing = true;
  }

  function isClosing(): boolean {
    return closing;
  }

  return { refresh, scheduledTick, start, stop, getState, setClosing, isClosing };
}
