// Online-then-offline snapshot resolver plus the client error taxonomy.
// Reads try GET /api/state and fall back to a labeled read-only snapshot
// over the local database (never migrating, never writing) on transport
// failure only. A live service answering HTTP errors is reported as-is.
import fs from "node:fs";
import { createRequire } from "node:module";
import { buildSnapshot } from "../advisory/snapshot.js";
import type { StateSnapshot } from "../advisory/types.js";
import { migrate } from "../store/db.js";
import { ServiceError, ServiceUnavailable, type ServiceClient } from "../runtime/client.js";
import { VERSION } from "../version.js";

export type ClientErrorKind =
  | "no-data"
  | "incompatible-schema"
  | "service-error"
  | "incompatible-service"
  | "service-unavailable";

export class ClientError extends Error {
  kind: ClientErrorKind;
  constructor(kind: ClientErrorKind, message: string) {
    super(message);
    this.name = "ClientError";
    this.kind = kind;
  }
}

// stderr label for labeled offline fallback (stdout stays a pure data contract).
export const OFFLINE_LABEL = "offline: showing stored readings (service unreachable)";

// A client that always fails transport: forces resolveSnapshot down the
// labeled offline path without touching the network. Used when the daemon
// is reachable but too old for an unmanaged takeover.
export function offlineOnlyClient(): ServiceClient {
  const fail = async (): Promise<never> => {
    throw new ServiceUnavailable("service unavailable: skew fallback to stored readings");
  };
  return { get: fail, post: fail };
}

const NO_DATA_HINT = "no quotas yet - start the service (quotacap web)";

function unreadableMessage(dbPath: string): string {
  return `incompatible-schema: ${dbPath} is not a current QuotaCap database - start the service (quotacap web) to upgrade it`;
}

function offlineRuntime(): StateSnapshot["runtime"] {
  return {
    available: false,
    ready: false,
    polling: "idle",
    lastCompletedPollAt: null,
    version: VERSION,
  };
}

// Transport failures become service-unavailable, HTTP failures become
// service-error; anything else is a bug and propagates unwrapped.
export function toClientError(e: unknown, action: string): ClientError {
  if (e instanceof ServiceUnavailable) {
    return new ClientError("service-unavailable", `service-unavailable: ${action} failed: ${e.message}`);
  }
  if (e instanceof ServiceError) {
    return new ClientError(
      "service-error",
      `service-error: ${action} failed: HTTP ${e.status}: ${e.body.slice(0, 160)}`,
    );
  }
  throw e;
}

const require = createRequire(import.meta.url);
const BUN_SQLITE = "bun:sqlite";

function loadSqlite(): { SQLite: any; bun: boolean } {
  try {
    return { SQLite: require("node:sqlite").DatabaseSync, bun: false };
  } catch {
    return { SQLite: require(BUN_SQLITE).Database, bun: true };
  }
}

// Read-only open: never creates, migrates, chmods, or journals. The
// readOnly flag plus PRAGMA query_only reject every write path.
export function openOfflineDb(dbPath: string): any {
  const { SQLite, bun } = loadSqlite();
  let db: any;
  try {
    db = bun ? new SQLite(dbPath, { readonly: true, create: false }) : new SQLite(dbPath, { readOnly: true });
  } catch {
    if (!fs.existsSync(dbPath)) throw new ClientError("no-data", NO_DATA_HINT);
    throw new ClientError("incompatible-schema", unreadableMessage(dbPath));
  }
  db.exec("PRAGMA query_only = ON");
  return db;
}

const QUOTAS_COLUMNS = [
  "id",
  "provider",
  "plan",
  "used_pct",
  "resets_at",
  "period_start",
  "source",
  "fetched_at",
  "credits_usd",
  "resets_at_estimated",
  "session_pct",
];
const ATTEMPT_COLUMNS = [
  "provider",
  "attempted_at",
  "completed_at",
  "succeeded_at",
  "success",
  "failure_category",
];

function tableColumns(db: any, table: string): Set<string> | null {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.length) return null;
    return new Set(cols.map((c) => c.name));
  } catch {
    return null;
  }
}

// Schema precheck before any projection: legacy or foreign files get the
// upgrade instruction, never migrate().
function assertCompatibleSchema(db: any, dbPath: string): void {
  const quotas = tableColumns(db, "quotas");
  const attempts = tableColumns(db, "adapter_attempts");
  const ok =
    quotas !== null &&
    attempts !== null &&
    QUOTAS_COLUMNS.every((c) => quotas.has(c)) &&
    ATTEMPT_COLUMNS.every((c) => attempts.has(c));
  if (!ok) throw new ClientError("incompatible-schema", unreadableMessage(dbPath));
}

// Row count first: no rows is no-data even when the schema is absent or
// legacy, since there is nothing to upgrade. Returns null when the quotas
// table itself is missing.
function quotaRowCount(db: any, dbPath: string): number | null {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM quotas`).get() as { n: number };
    return row.n;
  } catch (e: any) {
    if (/no such table/i.test(String(e?.message ?? ""))) return null;
    throw new ClientError("incompatible-schema", unreadableMessage(dbPath));
  }
}

function isStateEnvelope(state: unknown): state is StateSnapshot {
  if (typeof state !== "object" || state === null) return false;
  const s = state as Record<string, unknown>;
  return (
    typeof s.asOf === "string" &&
    typeof s.runtime === "object" &&
    s.runtime !== null &&
    Array.isArray(s.providers) &&
    typeof s.recommendation === "object" &&
    s.recommendation !== null
  );
}

async function serviceVersion(client: ServiceClient): Promise<string> {
  try {
    const health = (await client.get("/health")) as any;
    return typeof health?.version === "string" && health.version ? health.version : "unknown";
  } catch {
    return "unknown";
  }
}

// Missing /api/state (or a body outside the envelope) on a live service:
// version skew is incompatible-service naming both versions; the same
// version answering wrongly is a service-error, never a silent fallback.
async function versionSkewOrBroken(client: ServiceClient, notFound: ServiceError | null): Promise<never> {
  const v = await serviceVersion(client);
  if (v !== "unknown" && v === VERSION) {
    if (notFound) throw toClientError(notFound, "GET /api/state");
    throw new ClientError("service-error", "service-error: GET /api/state returned an unexpected response");
  }
  const detail = notFound
    ? "service does not support GET /api/state"
    : "service returned an unexpected /api/state response";
  throw new ClientError(
    "incompatible-service",
    `incompatible-service: ${detail} (service version ${v}, this CLI is ${VERSION})`,
  );
}

export type SnapshotSource = "service" | "offline";

export interface ResolvedSnapshot {
  snapshot: StateSnapshot;
  source: SnapshotSource;
  asOf: string;
}

export interface ResolveSnapshotOptions {
  client: ServiceClient;
  dbPath: string;
  enabledProviders: string[];
  now?: Date;
  openDb?: (dbPath: string) => any;
}

async function offlineSnapshot(opts: ResolveSnapshotOptions, now: Date): Promise<ResolvedSnapshot> {
  const { dbPath, enabledProviders } = opts;
  if (!fs.existsSync(dbPath)) throw new ClientError("no-data", NO_DATA_HINT);
  const open = opts.openDb ?? openOfflineDb;
  const db = open(dbPath);
  try {
    const count = quotaRowCount(db, dbPath);
    if (count === null || count === 0) throw new ClientError("no-data", NO_DATA_HINT);
    assertCompatibleSchema(db, dbPath);
    const snapshot = buildSnapshot(db, { enabledProviders, now, runtime: offlineRuntime() });
    return { snapshot, source: "offline", asOf: snapshot.asOf };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore close errors */
    }
  }
}

export async function resolveSnapshot(opts: ResolveSnapshotOptions): Promise<ResolvedSnapshot> {
  const now = opts.now ?? new Date();
  try {
    const state = await opts.client.get("/api/state");
    if (!isStateEnvelope(state)) return versionSkewOrBroken(opts.client, null);
    const snapshot = state as StateSnapshot;
    return { snapshot, source: "service", asOf: snapshot.asOf };
  } catch (e) {
    if (e instanceof ServiceUnavailable) return offlineSnapshot(opts, now);
    if (e instanceof ServiceError && e.status === 404) return versionSkewOrBroken(opts.client, e);
    if (e instanceof ServiceError) throw toClientError(e, "GET /api/state");
    throw e;
  }
}

// The no-data contract: an empty projection with the offline runtime block,
// built over a throwaway :memory: database (never the user's file).
export function emptySnapshot(now: Date): StateSnapshot {
  const { SQLite } = loadSqlite();
  const db = new SQLite(":memory:");
  try {
    migrate(db);
    return buildSnapshot(db, { enabledProviders: [], now, runtime: offlineRuntime() });
  } finally {
    try {
      db.close();
    } catch {
      /* ignore close errors */
    }
  }
}
