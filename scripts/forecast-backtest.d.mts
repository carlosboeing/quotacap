// Types for the forecast backtest script (scripts/forecast-backtest.mjs).
// Kept beside it so the typechecker can resolve test imports; emits nothing.

export interface ForecastConstants {
  K: number;
  M: number;
  T: number;
}

export interface QuotaRow {
  id?: number | null;
  provider: string;
  plan?: string | null;
  usedPct: number;
  resetsAt: string;
  periodStart?: string | null;
  source?: string | null;
  fetchedAt: string;
  resetsAtEstimated?: boolean;
}

export interface CloseRow {
  id?: number | null;
  provider: string;
  plan?: string | null;
  usedPct: number;
  leftoverPct: number;
  sampledAt: string;
  periodStart?: string | null;
  resetsAt?: string | null;
  resetsAtEstimated?: boolean;
  detectedAt: string;
  reason?: string | null;
}

export interface Dataset {
  quotas: QuotaRow[];
  closes: CloseRow[];
}

export type WeekLabelName = "capped" | "clearly-not-capped" | "neutral" | "unlabeled";

export interface WeekLabel {
  id: number | null;
  provider: string;
  plan: string | null;
  usedPct: number;
  leftoverPct: number;
  sampledAt: string;
  periodStart: string | null;
  resetsAt: string | null;
  detectedAt: string;
  estimated: boolean;
  label: WeekLabelName;
  startMs: number;
  endMs: number;
}

export interface Verdict {
  provider: string;
  daysLeft: number;
  remaining: number;
  idealRate: number;
  burnRate: number | null;
  recentRate: number | null;
  baselineRate: number | null;
  aheadOfElapsed: boolean | null;
  avgPace: number | null;
  burnMeasured: boolean;
  paceSource: string;
  daysToExhaust: number | null;
  status: string;
  wastePct: number | null;
  urgency: string;
}

export interface DayVerdict {
  provider: string;
  day: string;
  asOf: string;
  estimated: boolean;
  usedPct: number;
  weekId: number | null;
  label: WeekLabelName;
  daysToClose: number | null;
  candidate: Verdict;
  current: Verdict;
}

export interface Metric {
  total: number;
  verified: number;
  estimated: number;
}

export interface NullableMetric {
  total: number | null;
  verified: number | null;
  estimated: number | null;
}

export interface FormulaScores {
  falseRedDays: Metric;
  missedCaps: Metric;
  dteSamples: Metric;
  meanAbsDteError: NullableMetric;
}

export interface BacktestScores {
  candidate: FormulaScores;
  current: FormulaScores;
}

export interface Gate {
  falseRedFall: number;
  newMissedCaps: number;
  pass: boolean;
}

export interface BacktestResult {
  constants: ForecastConstants;
  evaluable: boolean;
  quotaCount: number;
  providerCount: number;
  receiptCount: number;
  days: DayVerdict[];
  weeks: WeekLabel[];
  scores: BacktestScores;
  gate: Gate;
}

export interface CliOptions {
  db: string | null;
  fixture: string | null;
  constants: ForecastConstants;
  json: boolean;
  help: boolean;
}

export const DEFAULT_CONSTANTS: ForecastConstants;

export function averagePace(q: QuotaRow, now: Date): number | null;

export function blendForecast(recent: number | null, baseline: number | null, K: number): number | null;

export function baselineFor(historyAvg: number | null, q: QuotaRow, now: Date): number | null;

/** Mirror of getBurnRates for one provider over rows visible at `nowMs`. */
export function recentRateForCycle(rows: QuotaRow[], nowMs: number): number | null;

/** Mirror of getHistoryBaseline over the closes visible at one boundary. */
export function historyBaselineFor(closes: CloseRow[], limit?: number): number | null;

export function candidateVerdict(
  q: QuotaRow,
  recent: number | null,
  baseline: number | null,
  now: Date,
  constants?: ForecastConstants,
): Verdict;

export function currentVerdict(
  q: QuotaRow,
  recent: number | null,
  windowAvg: number | null,
  now: Date,
): Verdict;

export function loadDatasetFromJson(raw: unknown): Dataset;

export function loadDatasetFromDb(dbPath: string): Dataset;

export function replay(
  dataset: Dataset,
  constants?: ForecastConstants,
): { days: DayVerdict[]; weeks: WeekLabel[] };

export function score(days: DayVerdict[], weeks: WeekLabel[]): BacktestScores;

export function buildGate(scores: BacktestScores, evaluable: boolean): Gate;

export function runBacktest(dataset: Dataset, constants?: ForecastConstants): BacktestResult;

export function formatReport(result: BacktestResult): string;

export function parseArgs(argv: string[]): CliOptions;

export function main(argv?: string[]): number;
