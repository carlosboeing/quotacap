import type { DiagnosticCode } from "../diagnostics/failure.js";

export type FailureCategory = "timeout" | "auth" | "parse" | "network" | "skipped" | "unknown" | null;

export interface AttemptRecord {
  provider: string;
  attemptedAt: string;
  completedAt: string | null;
  succeededAt: string | null;
  success: boolean;
  failureCategory: FailureCategory;
  diagnosticCode?: DiagnosticCode | null;
  summary?: string | null;
  action?: string | null;
  errorDetail?: string | null;
  error?: string | null;
}

function mapAttempt(r: any): AttemptRecord {
  return {
    provider: r.provider,
    attemptedAt: r.attempted_at,
    completedAt: r.completed_at ?? null,
    succeededAt: r.succeeded_at ?? null,
    success: !!r.success,
    failureCategory: r.failure_category ?? null,
    diagnosticCode: r.diagnostic_code ?? null,
    summary: r.summary ?? null,
    action: r.action ?? null,
    errorDetail: r.error_detail ?? null,
    error: r.error_detail ?? null,
  };
}

export function recordAttempt(db: any, a: AttemptRecord): void {
  const isFailure = !a.success && a.failureCategory !== "skipped";
  const diagnosticCode = isFailure ? (a.diagnosticCode ?? null) : null;
  const summary = isFailure ? (a.summary ?? null) : null;
  const action = isFailure ? (a.action ?? null) : null;
  const errorDetail = isFailure ? (a.errorDetail ?? null) : null;

  db.prepare(`INSERT INTO adapter_attempts(provider, attempted_at, completed_at, succeeded_at, success, failure_category, diagnostic_code, summary, action, error_detail)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET attempted_at=excluded.attempted_at, completed_at=excluded.completed_at,
    succeeded_at=COALESCE(excluded.succeeded_at, adapter_attempts.succeeded_at), success=excluded.success, failure_category=excluded.failure_category,
    diagnostic_code=excluded.diagnostic_code, summary=excluded.summary, action=excluded.action, error_detail=excluded.error_detail`)
    .run(
      a.provider,
      a.attemptedAt,
      a.completedAt ?? null,
      a.succeededAt ?? null,
      a.success ? 1 : 0,
      a.failureCategory ?? null,
      diagnosticCode,
      summary,
      action,
      errorDetail,
    );
}

export function getAttempt(db: any, provider: string): AttemptRecord | null {
  const r = db.prepare(`SELECT * FROM adapter_attempts WHERE provider=?`).get(provider);
  if (!r) return null;
  return mapAttempt(r);
}

export function getAttempts(db: any): AttemptRecord[] {
  return db.prepare(`SELECT * FROM adapter_attempts ORDER BY provider`).all().map(mapAttempt);
}
