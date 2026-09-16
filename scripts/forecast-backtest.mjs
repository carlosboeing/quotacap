#!/usr/bin/env node
// Forecast backtest harness — a dev tool, not a product surface.
//
// Replays recorded history with day-granularity visibility: for each provider
// day boundary it exposes only quota rows and close receipts at or before that
// instant, recomputes recent rate, history baseline, forecast and verdict under
// candidate constants (K, M, T), and scores each closed week against its
// recorded close receipt (the recorded-receipt path — no derived receipts).
//
// Semantics (design 2026-09-16-pace-normalization-design.md section 9):
//   - A verdict exists for every UTC day with at least one quota row, evaluated
//     at the following midnight (the day boundary). Rows at or before that
//     instant are visible; later rows and receipts are not.
//   - recent rate mirrors getBurnRates (src/store/quotas.ts): 24h rolling delta
//     within the current cycle, null under MIN_PACE_SPAN_DAYS or one row.
//   - baseline mirrors getHistoryBaseline (verified-preferred newest-4 pool,
//     mean usedPct / 7), falling back to averagePace exactly like baselineFor.
//   - Week labels come from recorded receipts only: leftover < 5 is "capped",
//     leftover > 15 is "clearly-not-capped", the middle is "neutral" and is
//     excluded from error counts; days with no receipt are "unlabeled".
//   - Scores: false-red provider-days (red in a clearly-not-capped week),
//     missed caps (a capped week with no red in its final 3 days), and mean
//     |dte - actual| on capped weeks where actual is days from the day
//     boundary to the receipt window end (resetsAt, else sampledAt) — each
//     stratified estimated versus verified. Days with a non-finite dte are
//     excluded from the mean.
//
// The verdict math is reimplemented here because the tool runs as plain Node
// ESM against a SQLite file. candidateVerdict is a faithful mirror of
// computeAdvisory (src/advisory/engine.ts) at the shipped constants, verified
// field-for-field by tests/scripts/forecast-backtest.test.ts. currentVerdict is
// the pre-blend reference the design gates against: raw 24h rate (window
// average fallback), zero margin, no gate — red iff daysToExhaust < daysLeft —
// and it carries no estimated clock handling, no aheadOfElapsed, and no
// recentRate/baselineRate, exactly like the code it mirrors.
//
// Read-only: --db opens the database with node:sqlite readOnly and never writes.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const DAY_MS = 86400000;

// Mirrors src/advisory/types.ts; locked by tests/scripts/forecast-backtest.test.ts.
export const DEFAULT_CONSTANTS = { K: 0.5, M: 0.15, T: 0.1 };

// minimum data span before a pace annualizes — mirrors MIN_PACE_SPAN_DAYS.
const MIN_PACE_SPAN_DAYS = 6 / 24;

// A capped week's final 3 days are the boundaries fewer than 3 days before the
// receipt window end (2, 1 and 0 days out).
const FINAL_THREE_DAYS = 3;

// ---------------------------------------------------------------- pace math

export function averagePace(q, now) {
  if (!q.periodStart) return null;
  const start = new Date(q.periodStart).getTime();
  if (Number.isNaN(start)) return null;
  const elapsedDays = (now.getTime() - start) / DAY_MS;
  if (elapsedDays < MIN_PACE_SPAN_DAYS) return null;
  const pace = q.usedPct / elapsedDays;
  if (!Number.isFinite(pace)) return null;
  return Math.max(0, pace);
}

export function blendForecast(recent, baseline, K) {
  if (recent === null) return baseline;
  if (baseline === null) return recent;
  return Math.max(0, baseline + K * (recent - baseline));
}

export function baselineFor(historyAvg, q, now) {
  if (historyAvg !== null) return historyAvg;
  return averagePace(q, now);
}

function elapsedPctOf(q, now) {
  if (!q.periodStart) return null;
  const start = new Date(q.periodStart).getTime();
  const resets = new Date(q.resetsAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(resets)) return null;
  const span = resets - start;
  if (!(span > 0)) return null;
  const elapsed = now.getTime() - start;
  if (!(elapsed > 0)) return null;
  return Math.min(100, Math.max(0, (elapsed / span) * 100));
}

// ------------------------------------------------------------------ verdicts

export function candidateVerdict(q, recent, baseline, now, constants = DEFAULT_CONSTANTS) {
  const { K, M, T } = constants;
  const resets = new Date(q.resetsAt);
  const daysLeft = Math.max(0.1, (resets.getTime() - now.getTime()) / DAY_MS);
  const remaining = 100 - q.usedPct;
  const idealRate = remaining / daysLeft;
  const avgPace = averagePace(q, now);
  const exhausted = remaining <= 0;
  const burnRate = blendForecast(recent, baseline, K);

  const paceSource = recent !== null ? "recent" : burnRate !== null ? "window-average" : "unknown";
  const burnMeasured = recent !== null;

  if (burnRate === null) {
    return {
      provider: q.provider,
      daysLeft,
      remaining,
      idealRate,
      burnRate: null,
      recentRate: null,
      baselineRate: null,
      aheadOfElapsed: null,
      avgPace,
      burnMeasured: false,
      paceSource: "unknown",
      daysToExhaust: exhausted ? 0 : null,
      status: exhausted ? "at risk" : "unknown",
      wastePct: exhausted ? 0 : null,
      urgency: exhausted ? "slow down" : "on track",
    };
  }
  if (exhausted) {
    return {
      provider: q.provider,
      daysLeft,
      remaining,
      idealRate,
      burnRate,
      recentRate: null,
      baselineRate: null,
      aheadOfElapsed: null,
      avgPace,
      burnMeasured,
      paceSource,
      daysToExhaust: 0,
      status: "at risk",
      wastePct: 0,
      urgency: "slow down",
    };
  }

  const elapsed = elapsedPctOf(q, now);
  const estimated = q.resetsAtEstimated === true;
  const gate = elapsed !== null && !estimated && q.usedPct >= elapsed * (1 - T);
  const aheadOfElapsed = elapsed !== null && !estimated && q.usedPct > elapsed * (1 + T);

  const wastePct = Math.max(0, remaining - burnRate * daysLeft);
  const daysToExhaust = burnRate > 0 ? remaining / burnRate : Infinity;
  const over = daysToExhaust < daysLeft * (1 - M);
  const marginal = !over && daysToExhaust < daysLeft * (1 + M);
  let status;
  if (over && gate) status = "at risk";
  else if (over || marginal) status = "watch";
  else status = "on track";

  let urgency = "on track";
  if (wastePct > 30 && daysLeft < 3) urgency = "burn now";
  else if (wastePct > 20 && daysLeft < 7) urgency = "use soon";
  else if (burnRate > idealRate * 1.4) urgency = "slow down";
  else if (wastePct > 10) urgency = "save";
  if (estimated && urgency === "burn now") urgency = "use soon";

  return {
    provider: q.provider,
    daysLeft,
    remaining,
    idealRate,
    burnRate,
    recentRate: recent,
    baselineRate: baseline,
    aheadOfElapsed,
    avgPace,
    burnMeasured,
    paceSource,
    daysToExhaust,
    status,
    wastePct,
    urgency,
  };
}

// Pre-blend reference: the formula this branch replaces. Red iff
// daysToExhaust < daysLeft with the raw 24h rate (window-average fallback), no
// margin, no gate, no estimated clock. Mirrors origin/main's computeAdvisory
// as recommend() called it.
export function currentVerdict(q, recent, windowAvg, now) {
  const resets = new Date(q.resetsAt);
  const daysLeft = Math.max(0.1, (resets.getTime() - now.getTime()) / DAY_MS);
  const remaining = 100 - q.usedPct;
  const idealRate = remaining / daysLeft;
  const avgPace = averagePace(q, now);
  const exhausted = remaining <= 0;
  const burnRate = recent !== null ? recent : windowAvg;

  const paceSource = recent !== null ? "recent" : burnRate !== null ? "window-average" : "unknown";
  const burnMeasured = recent !== null;

  if (burnRate === null) {
    return {
      provider: q.provider,
      daysLeft,
      remaining,
      idealRate,
      burnRate: null,
      recentRate: null,
      baselineRate: null,
      aheadOfElapsed: null,
      avgPace,
      burnMeasured: false,
      paceSource: "unknown",
      daysToExhaust: exhausted ? 0 : null,
      status: exhausted ? "at risk" : "unknown",
      wastePct: exhausted ? 0 : null,
      urgency: exhausted ? "slow down" : "on track",
    };
  }
  if (exhausted) {
    return {
      provider: q.provider,
      daysLeft,
      remaining,
      idealRate,
      burnRate,
      recentRate: null,
      baselineRate: null,
      aheadOfElapsed: null,
      avgPace,
      burnMeasured,
      paceSource,
      daysToExhaust: 0,
      status: "at risk",
      wastePct: 0,
      urgency: "slow down",
    };
  }

  const wastePct = Math.max(0, remaining - burnRate * daysLeft);
  const daysToExhaust = burnRate > 0 ? remaining / burnRate : Infinity;
  const status = daysToExhaust < daysLeft ? "at risk" : "on track";

  let urgency = "on track";
  if (wastePct > 30 && daysLeft < 3) urgency = "burn now";
  else if (wastePct > 20 && daysLeft < 7) urgency = "use soon";
  else if (burnRate > idealRate * 1.4) urgency = "slow down";
  else if (wastePct > 10) urgency = "save";

  return {
    provider: q.provider,
    daysLeft,
    remaining,
    idealRate,
    burnRate,
    recentRate: null,
    baselineRate: null,
    aheadOfElapsed: null,
    avgPace,
    burnMeasured,
    paceSource,
    daysToExhaust,
    status,
    wastePct,
    urgency,
  };
}

// ------------------------------------------------------- cycle-window mirrors

function cycleBreakReason(prev, cur) {
  const dropped = cur.usedPct < prev.usedPct;
  const prevResets = prev.resetsAt ? new Date(prev.resetsAt).getTime() : NaN;
  const boundaryRolled =
    !Number.isNaN(prevResets) && prevResets <= cur.t && prev.resetsAt !== cur.resetsAt;
  if (dropped && boundaryRolled) return "both";
  if (dropped) return "usage-drop";
  if (boundaryRolled) return "resets-at-rolled";
  return null;
}

function isWeeklyCycleBreak(prev, cur) {
  return cycleBreakReason(prev, cur) !== null;
}

function currentCycle(sorted) {
  let start = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (isWeeklyCycleBreak(sorted[i - 1], sorted[i])) start = i;
  }
  return start === 0 ? sorted : sorted.slice(start);
}

// getBurnRates for one provider over the visible rows.
export function recentRateForCycle(rows, nowMs) {
  const pts = [];
  for (const r of rows) {
    const t = Date.parse(r.fetchedAt);
    if (Number.isNaN(t) || t > nowMs) continue;
    pts.push({ usedPct: r.usedPct, t, resetsAt: r.resetsAt ?? null });
  }
  if (!pts.length) return null;
  const sorted = currentCycle(pts.sort((a, b) => a.t - b.t));
  const latest = sorted[sorted.length - 1];
  const cutoff = latest.t - DAY_MS;
  const windowStart = sorted.find((p) => p.t >= cutoff) ?? sorted[0];
  const days = (latest.t - windowStart.t) / DAY_MS;
  if (sorted.length < 2 || days < MIN_PACE_SPAN_DAYS) return null;
  const burn = (latest.usedPct - windowStart.usedPct) / days;
  return burn >= 0 && Number.isFinite(burn) ? burn : null;
}

// getHistoryBaseline for one provider over the visible closes.
export function historyBaselineFor(closes, limit = 4) {
  const newestFirst = [...closes]
    .sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt) || (b.id ?? 0) - (a.id ?? 0))
    .slice(0, limit);
  if (!newestFirst.length) return null;
  const verified = newestFirst.filter((c) => !c.resetsAtEstimated);
  const chosen = verified.length ? verified : newestFirst;
  const mean = chosen.reduce((sum, c) => sum + c.usedPct, 0) / chosen.length;
  const rate = mean / 7;
  return Number.isFinite(rate) ? rate : null;
}

// -------------------------------------------------------------- dataset I/O

function normalizeQuota(row) {
  return {
    id: row.id ?? null,
    provider: row.provider,
    plan: row.plan ?? null,
    usedPct: row.usedPct ?? row.used_pct,
    resetsAt: row.resetsAt ?? row.resets_at,
    periodStart: row.periodStart ?? row.period_start ?? null,
    source: row.source ?? null,
    fetchedAt: row.fetchedAt ?? row.fetched_at,
    resetsAtEstimated: row.resetsAtEstimated === true || row.resets_at_estimated === 1 || row.resets_at_estimated === true,
  };
}

function normalizeClose(row) {
  return {
    id: row.id ?? null,
    provider: row.provider,
    plan: row.plan ?? null,
    usedPct: row.usedPct ?? row.used_pct,
    leftoverPct: row.leftoverPct ?? row.leftover_pct,
    sampledAt: row.sampledAt ?? row.sampled_at,
    periodStart: row.periodStart ?? row.period_start ?? null,
    resetsAt: row.resetsAt ?? row.resets_at ?? null,
    resetsAtEstimated: row.resetsAtEstimated === true || row.resets_at_estimated === 1 || row.resets_at_estimated === true,
    detectedAt: row.detectedAt ?? row.detected_at,
    reason: row.reason ?? null,
  };
}

export function loadDatasetFromJson(raw) {
  return {
    quotas: (raw.quotas ?? []).map(normalizeQuota),
    closes: (raw.windowCloses ?? raw.window_closes ?? []).map(normalizeClose),
  };
}

let DatabaseSync = null;
function sqlite() {
  if (!DatabaseSync) {
    try {
      ({ DatabaseSync } = require("node:sqlite"));
    } catch (e) {
      throw new Error(
        "forecast-backtest needs Node.js with node:sqlite (engines: node >= 22.13): " + (e && e.message),
      );
    }
  }
  return DatabaseSync;
}

export function loadDatasetFromDb(dbPath) {
  if (!fs.existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  const db = new (sqlite())(dbPath, { readOnly: true });
  try {
    const quotas = db
      .prepare(
        `SELECT id, provider, plan, used_pct, resets_at, period_start, source, fetched_at, resets_at_estimated FROM quotas ORDER BY id`,
      )
      .all();
    let closes = [];
    try {
      closes = db
        .prepare(
          `SELECT id, provider, plan, used_pct, leftover_pct, sampled_at, period_start, resets_at, resets_at_estimated, detected_at, reason FROM window_closes ORDER BY id`,
        )
        .all();
    } catch (e) {
      // A pre-observability database has no ledger table; no table means no
      // recorded closes, exactly like getWindowCloses/getHistoryBaseline.
      if (!/no such table/i.test(String((e && e.message) || ""))) throw e;
    }
    return { quotas: quotas.map(normalizeQuota), closes: closes.map(normalizeClose) };
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------- replay

function summarizeWeeks(closes) {
  return closes.map((c) => {
    const sampledMs = Date.parse(c.sampledAt);
    const startMs = c.periodStart ? Date.parse(c.periodStart) : sampledMs - 7 * DAY_MS;
    const endMs = c.resetsAt ? Date.parse(c.resetsAt) : sampledMs;
    let label = "neutral";
    if (c.leftoverPct < 5) label = "capped";
    else if (c.leftoverPct > 15) label = "clearly-not-capped";
    return {
      id: c.id,
      provider: c.provider,
      plan: c.plan ?? null,
      usedPct: c.usedPct,
      leftoverPct: c.leftoverPct,
      sampledAt: c.sampledAt,
      periodStart: c.periodStart,
      resetsAt: c.resetsAt,
      detectedAt: c.detectedAt,
      estimated: c.resetsAtEstimated === true,
      label,
      startMs,
      endMs,
    };
  });
}

function weekFor(provider, asOfMs, weeks) {
  let best = null;
  for (const w of weeks) {
    if (w.provider !== provider) continue;
    if (w.endMs < asOfMs || w.startMs > asOfMs) continue;
    if (!best || w.endMs < best.endMs) best = w;
  }
  return best;
}

// UTC calendar day of a timestamp. Real DBs and the fixture write Z-suffixed
// ISO strings; normalizing through Date keeps offset timestamps on the day
// their UTC instant falls in instead of silently shifting week membership.
function utcDay(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`invalid timestamp: ${iso}`);
  return new Date(ms).toISOString().slice(0, 10);
}

export function replay(dataset, constants = DEFAULT_CONSTANTS) {
  const byProvider = new Map();
  for (const q of dataset.quotas) {
    const rows = byProvider.get(q.provider) ?? [];
    rows.push(q);
    byProvider.set(q.provider, rows);
  }

  const weeks = summarizeWeeks(dataset.closes);
  const days = [];

  for (const [provider, rows] of [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = [...rows].sort(
      (a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt) || (a.id ?? 0) - (b.id ?? 0),
    );
    const dayKeys = [...new Set(sorted.map((r) => utcDay(r.fetchedAt)))].sort();

    for (const day of dayKeys) {
      const asOfMs = Date.parse(`${day}T00:00:00.000Z`) + DAY_MS;
      const asOf = new Date(asOfMs);
      const visible = sorted.filter((r) => Date.parse(r.fetchedAt) <= asOfMs);
      const q = visible[visible.length - 1];
      if (!q) continue;

      const recent = recentRateForCycle(visible, asOfMs);
      const history = historyBaselineFor(
        dataset.closes.filter((c) => c.provider === provider && Date.parse(c.detectedAt) <= asOfMs),
      );
      const baseline = baselineFor(history, q, asOf);
      const candidate = candidateVerdict(q, recent, baseline, asOf, constants);
      const current = currentVerdict(q, recent, averagePace(q, asOf), asOf);
      const week = weekFor(provider, asOfMs, weeks);
      const daysToClose = week ? Math.max(0, (week.endMs - asOfMs) / DAY_MS) : null;

      days.push({
        provider,
        day,
        asOf: asOf.toISOString(),
        estimated: q.resetsAtEstimated === true,
        usedPct: q.usedPct,
        weekId: week ? week.id : null,
        label: week ? week.label : "unlabeled",
        daysToClose,
        candidate,
        current,
      });
    }
  }

  return { days, weeks };
}

// ------------------------------------------------------------------ scoring

function emptyAcc() {
  return { falseRedDays: 0, missedCaps: 0, unobservedFinalThree: 0, dteSamples: 0, dteSum: 0 };
}

function scoreFormula(days, weeks, key) {
  const acc = { total: emptyAcc(), verified: emptyAcc(), estimated: emptyAcc() };

  for (const day of days) {
    const stratum = day.estimated ? acc.estimated : acc.verified;
    const verdict = day[key];
    if (day.label === "clearly-not-capped" && verdict.status === "at risk") {
      stratum.falseRedDays++;
      acc.total.falseRedDays++;
    }
    if (day.label === "capped" && typeof verdict.daysToExhaust === "number" && Number.isFinite(verdict.daysToExhaust)) {
      const err = Math.abs(verdict.daysToExhaust - day.daysToClose);
      stratum.dteSamples++;
      stratum.dteSum += err;
      acc.total.dteSamples++;
      acc.total.dteSum += err;
    }
  }

  for (const week of weeks) {
    if (week.label !== "capped") continue;
    // The final 3 days are the last three day-boundary verdicts before the
    // receipt's window end: boundaries 2, 1 and 0 days out. A boundary
    // exactly 3 days out starts the final stretch, it is not inside it.
    const finalThree = days.filter(
      (d) =>
        d.weekId === week.id && typeof d.daysToClose === "number" && d.daysToClose < FINAL_THREE_DAYS,
    );
    if (finalThree.length === 0) {
      // No verdict inside the final stretch at all: a data gap (sparse polls,
      // a sleeping laptop), not evidence of a missed cap. Counted separately
      // so the missed-cap absolutes stay honest; both formulas see the same
      // gap, so the gate delta is unaffected.
      (week.estimated ? acc.estimated : acc.verified).unobservedFinalThree++;
      acc.total.unobservedFinalThree++;
      continue;
    }
    const redInFinalThree = finalThree.some((d) => d[key].status === "at risk");
    if (!redInFinalThree) {
      (week.estimated ? acc.estimated : acc.verified).missedCaps++;
      acc.total.missedCaps++;
    }
  }

  const metric = (pick) => ({
    total: pick(acc.total),
    verified: pick(acc.verified),
    estimated: pick(acc.estimated),
  });
  return {
    falseRedDays: metric((s) => s.falseRedDays),
    missedCaps: metric((s) => s.missedCaps),
    unobservedFinalThree: metric((s) => s.unobservedFinalThree),
    dteSamples: metric((s) => s.dteSamples),
    meanAbsDteError: metric((s) => (s.dteSamples ? s.dteSum / s.dteSamples : null)),
  };
}

export function score(days, weeks) {
  return {
    candidate: scoreFormula(days, weeks, "candidate"),
    current: scoreFormula(days, weeks, "current"),
  };
}

export function buildGate(scores, evaluable) {
  const falseRedFall = scores.current.falseRedDays.total - scores.candidate.falseRedDays.total;
  const newMissedCaps = scores.candidate.missedCaps.total - scores.current.missedCaps.total;
  return { falseRedFall, newMissedCaps, pass: evaluable && falseRedFall > 0 && newMissedCaps <= 0 };
}

export function runBacktest(dataset, constants = DEFAULT_CONSTANTS) {
  const { days, weeks } = replay(dataset, constants);
  const scores = score(days, weeks);
  const evaluable = weeks.length > 0;
  return {
    constants: { ...constants },
    evaluable,
    quotaCount: dataset.quotas.length,
    providerCount: new Set(dataset.quotas.map((q) => q.provider)).size,
    receiptCount: dataset.closes.length,
    days,
    weeks,
    scores,
    gate: buildGate(scores, evaluable),
  };
}

// ------------------------------------------------------------------- report

export function formatReport(result) {
  const lines = [];
  lines.push(
    `QuotaCap forecast backtest — constants K=${result.constants.K} M=${result.constants.M} T=${result.constants.T}`,
  );
  if (!result.evaluable) {
    lines.push(
      `not evaluable — 0 recorded close receipts (quotas: ${result.quotaCount}, providers: ${result.providerCount})`,
    );
    lines.push("labels and scores need window_closes receipts; no derived receipts are invented");
    return lines.join("\n") + "\n";
  }

  lines.push(
    `quotas: ${result.quotaCount} rows, ${result.providerCount} providers; close receipts: ${result.receiptCount}`,
  );
  lines.push("");
  lines.push("weeks (label from the recorded receipt):");
  lines.push("provider  sampled     left%  clock      label");
  for (const w of result.weeks) {
    lines.push(
      `${String(w.provider).padEnd(9)} ${String(w.sampledAt).slice(0, 10)}  ${w.leftoverPct.toFixed(1).padStart(5)}  ${(w.estimated ? "estimated" : "verified ")}  ${w.label}`,
    );
  }

  lines.push("");
  lines.push("scores (candidate vs current formula):");
  lines.push("            false-red days  missed caps  n(dte)  mean |dte - actual|");
  const fmt = (n) => (n === null ? "—" : n.toFixed(2));
  for (const key of ["candidate", "current"]) {
    const s = result.scores[key];
    lines.push(
      `${key.padEnd(10)}  ${String(s.falseRedDays.total).padStart(4)} (v${s.falseRedDays.verified}/e${s.falseRedDays.estimated})  ` +
        `${String(s.missedCaps.total).padStart(6)} (v${s.missedCaps.verified}/e${s.missedCaps.estimated})  ` +
        `${String(s.dteSamples.total).padStart(4)}    ${fmt(s.meanAbsDteError.total)} (v${fmt(s.meanAbsDteError.verified)}/e${fmt(s.meanAbsDteError.estimated)})`,
    );
  }

  const gaps = (key) => result.scores[key].unobservedFinalThree.total;
  lines.push("");
  lines.push(
    `data gaps: capped weeks with no day-boundary verdict in the final 3 days ` +
      `(excluded from missed caps): candidate ${gaps("candidate")}, current ${gaps("current")}`,
  );
  lines.push("");
  lines.push(
    `gate: false-red days fall ${result.gate.falseRedFall}, new missed caps ${result.gate.newMissedCaps} -> ` +
      `${result.gate.pass ? "PASS (substantiality is a human read of the fall)" : "FAIL"}`,
  );
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------- CLI

export function parseArgs(argv) {
  const opts = { db: null, fixture: null, constants: { ...DEFAULT_CONSTANTS }, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    if (arg === "--db") opts.db = next();
    else if (arg === "--fixture") opts.fixture = next();
    else if (arg === "--k") opts.constants.K = Number(next());
    else if (arg === "--m") opts.constants.M = Number(next());
    else if (arg === "--t") opts.constants.T = Number(next());
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const USAGE = [
  "usage:",
  "  node scripts/forecast-backtest.mjs --db <sqlite-path> [--k 0.5] [--m 0.15] [--t 0.10] [--json]",
  "  node scripts/forecast-backtest.mjs --fixture <json-path> [same]",
  "",
  "Replays recorded quota history day by day and scores the candidate constants",
  "against the current formula. Exit codes: 0 scored, 2 usage, 3 not evaluable",
  "(no recorded close receipts).",
].join("\n");

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(String((e && e.message) || e));
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (!opts.db && !opts.fixture) {
    console.error(USAGE);
    return 2;
  }

  const dataset = opts.db
    ? loadDatasetFromDb(opts.db)
    : loadDatasetFromJson(JSON.parse(fs.readFileSync(opts.fixture, "utf8")));
  const result = runBacktest(dataset, opts.constants);

  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatReport(result));

  return result.evaluable ? 0 : 3;
}

const isEntry = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
// exitCode, not process.exit(): an immediate exit truncates a piped stdout
// write mid-flush (the JSON report can exceed the 64KB pipe buffer).
if (isEntry) process.exitCode = main();
