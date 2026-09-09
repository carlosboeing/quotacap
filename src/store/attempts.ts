export type FailureCategory = "timeout" | "auth" | "parse" | "network" | "skipped" | "unknown" | null;

export interface AttemptRecord {
  provider: string;
  attemptedAt: string;
  completedAt: string | null;
  succeededAt: string | null;
  success: boolean;
  failureCategory: FailureCategory;
}

export function recordAttempt(db: any, a: AttemptRecord): void {
  db.prepare(`INSERT INTO adapter_attempts(provider, attempted_at, completed_at, succeeded_at, success, failure_category)
    VALUES(?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET attempted_at=excluded.attempted_at, completed_at=excluded.completed_at,
    succeeded_at=COALESCE(excluded.succeeded_at, adapter_attempts.succeeded_at), success=excluded.success, failure_category=excluded.failure_category`)
    .run(a.provider, a.attemptedAt, a.completedAt ?? null, a.succeededAt ?? null, a.success ? 1 : 0, a.failureCategory ?? null);
}

export function getAttempt(db: any, provider: string): AttemptRecord | null {
  const r = db.prepare(`SELECT * FROM adapter_attempts WHERE provider=?`).get(provider);
  if (!r) return null;
  return {
    provider: r.provider,
    attemptedAt: r.attempted_at,
    completedAt: r.completed_at,
    succeededAt: r.succeeded_at,
    success: !!r.success,
    failureCategory: r.failure_category,
  };
}

export function getAttempts(db: any): AttemptRecord[] {
  return db.prepare(`SELECT * FROM adapter_attempts ORDER BY provider`).all().map((r: any) => ({
    provider: r.provider,
    attemptedAt: r.attempted_at,
    completedAt: r.completed_at,
    succeededAt: r.succeeded_at,
    success: !!r.success,
    failureCategory: r.failure_category,
  }));
}
