import { emptyCatalog, type CatalogStatus, type CatalogView, type ListedModel } from "../catalog/types.js";

function isMissingTable(e: any): boolean {
  return /no such table/i.test(e?.message ?? "");
}

function mapCatalog(r: any): CatalogView {
  return {
    status: r.status,
    fetchedAt: r.fetched_at ?? null,
    listed: JSON.parse(r.models_json ?? "[]"),
    diagnosticCode: r.diagnostic_code ?? null,
    summary: r.summary ?? null,
    action: r.action ?? null,
  };
}

export function getCatalog(db: any, provider: string): CatalogView {
  let r: any;
  try {
    r = db.prepare(`SELECT * FROM model_catalogs WHERE provider=?`).get(provider);
  } catch (e: any) {
    // Pre-catalog DB or an offline file the daemon has not migrated: read as
    // unfetched. Never migrate or throw from a read helper.
    if (isMissingTable(e)) return emptyCatalog();
    throw e;
  }
  if (!r) return emptyCatalog();
  return mapCatalog(r);
}

export function getCatalogs(db: any): Map<string, CatalogView> {
  let rows: any[];
  try {
    rows = db.prepare(`SELECT * FROM model_catalogs`).all();
  } catch (e: any) {
    if (isMissingTable(e)) return new Map();
    throw e;
  }
  return new Map(rows.map((r: any) => [r.provider, mapCatalog(r)]));
}

export function upsertCatalog(db: any, provider: string, listed: ListedModel[], fetchedAt: string): void {
  db.prepare(`INSERT INTO model_catalogs(provider, status, models_json, fetched_at, diagnostic_code, summary, action, error_detail)
    VALUES(?,?,?,?,NULL,NULL,NULL,NULL)
    ON CONFLICT(provider) DO UPDATE SET status=excluded.status, models_json=excluded.models_json, fetched_at=excluded.fetched_at,
    diagnostic_code=NULL, summary=NULL, action=NULL, error_detail=NULL`)
    .run(provider, "ok", JSON.stringify(listed), fetchedAt);
}

export function markCatalogFailure(
  db: any,
  provider: string,
  diag: { diagnosticCode: string; summary: string; action: string; errorDetail: string },
): void {
  const row = db.prepare(`SELECT status FROM model_catalogs WHERE provider=?`).get(provider);
  if (row) {
    // A prior success degrades to stale and keeps models_json/fetched_at; a
    // repeated failure on an error row stays error.
    const status: CatalogStatus = row.status === "ok" ? "stale" : row.status;
    db.prepare(`UPDATE model_catalogs SET status=?, diagnostic_code=?, summary=?, action=?, error_detail=? WHERE provider=?`)
      .run(status, diag.diagnosticCode, diag.summary, diag.action, diag.errorDetail, provider);
  } else {
    db.prepare(`INSERT INTO model_catalogs(provider, status, models_json, fetched_at, diagnostic_code, summary, action, error_detail)
      VALUES(?, 'error', '[]', NULL, ?,?,?,?)`)
      .run(provider, diag.diagnosticCode, diag.summary, diag.action, diag.errorDetail);
  }
}
