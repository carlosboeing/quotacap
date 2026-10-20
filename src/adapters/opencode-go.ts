// Consented exception to credential-free polling: reads the OpenCode bearer
// in-memory, only after `providers enable opencode-go` records consent.
// v2 stores it in opencode.db. v1 stored an API key in auth.json.
// The static gate pins the auth-file literal to this adapter plus the
// generated dashboard bundle — see tests/adapters/credential-free.test.ts.
import { createRequire } from "node:module";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { adapterSignal } from "../runtime/spawn.js";
import { getCliVersion } from "../diagnostics/bundle.js";
import type { ParsedQuota } from "./types.js";

const require = createRequire(import.meta.url);

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const POLL_TIMEOUT_MS = 8000;

export const OPENCODE_LOGIN_COMMAND_V2 = "opencode auth login opencode";
export const OPENCODE_LOGIN_COMMAND_V1 = "opencode console login";

/** Login command for the installed OpenCode CLI major version, or null
 *  when the version text carries no readable major. */
export function openCodeLoginCommandForVersion(
  versionText: string | null | undefined,
): string | null {
  if (!versionText) return null;
  const m = versionText.match(/(?:^|\s)v?(\d+)\.\d+/);
  if (!m) return null;
  const major = parseInt(m[1], 10);
  if (major >= 2) return OPENCODE_LOGIN_COMMAND_V2;
  if (major === 1) return OPENCODE_LOGIN_COMMAND_V1;
  return null;
}

/** Best-effort local detection: `<opencode> --version`, never throws. */
export async function detectOpenCodeLoginCommand(
  versionReader: () => Promise<string | null> = () => getCliVersion("opencode"),
): Promise<string | null> {
  try {
    return openCodeLoginCommandForVersion(await versionReader());
  } catch {
    return null;
  }
}

export function openCodeGoConsentNotice(loginCommand?: string | null): string {
  const loginClause = loginCommand
    ? `when you ran \`${loginCommand}\``
    : `with the command for your CLI version: v2 \`${OPENCODE_LOGIN_COMMAND_V2}\` or v1 \`${OPENCODE_LOGIN_COMMAND_V1}\``;
  return [
  `• What is read: Bearer [REDACTED] already stored ${loginClause} (v2 \`~/.local/share/opencode/opencode.db\` active credential, else legacy \`~/.local/share/opencode/auth.json\`; \`opencode-go\` then \`opencode\`).`,
  "• Read frequency: in-memory, read-only once per poll (every 15 minutes by default).",
  "• Request destination: sent only as `Authorization: Bearer` to `https://opencode.ai/zen/go/v1/usage` to fetch `rolling/weekly/monthly` `percent` + `resetsAt`.",
  "• Never-list: never used to make chat or model requests, never written or rotated, never stored in the `quotacap` DB, never returned by the API or MCP, and never logged (errors show `[redacted]`).",
  "• Revocation instructions: revoke at `https://opencode.ai/auth` or `opencode providers logout opencode-go` and run `quotacap providers disable opencode-go` to stop polling.",
  "• Optional environment override: if you prefer no file access, set `OPENCODE_API_KEY` instead.",
  ].join("\n");
}

export const OPENCODE_GO_CONSENT_NOTICE = openCodeGoConsentNotice();

export function openCodeGoAuthPath(env: NodeJS.Dict<string> = process.env, home = os.homedir()): string {
  return path.join(openCodeDataDir(env, home), "auth.json");
}

/** v2 database. `OPENCODE_DB` wins, otherwise the OpenCode data directory. */
export function openCodeGoDbPath(env: NodeJS.Dict<string> = process.env, home = os.homedir()): string {
  const override = env.OPENCODE_DB;
  if (typeof override === "string" && override.length > 0) return override;
  return path.join(openCodeDataDir(env, home), "opencode.db");
}

function openCodeDataDir(env: NodeJS.Dict<string>, home: string): string {
  const xdg = env.XDG_DATA_HOME;
  if (typeof xdg === "string" && xdg.length > 0) return path.join(xdg, "opencode");
  return path.join(home, ".local", "share", "opencode");
}

/** Detection is existence only — no content read before enablement. */
export function opencodeGoDetected(env: NodeJS.Dict<string> = process.env, home = os.homedir()): boolean {
  try {
    return fsSync.existsSync(openCodeGoDbPath(env, home)) || fsSync.existsSync(openCodeGoAuthPath(env, home));
  } catch {
    return false;
  }
}

type SqliteDb = {
  prepare: (sql: string) => { all: () => Array<{ integration_id?: unknown; value?: unknown }> };
  close: () => void;
};

function openReadonlySqlite(dbPath: string): SqliteDb {
  try {
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string, opts: { readOnly: boolean }) => SqliteDb };
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ERR_UNKNOWN_BUILTIN_MODULE" && code !== "MODULE_NOT_FOUND") throw err;
    const { Database } = require("bun:sqlite") as { Database: new (p: string, opts: { readonly: boolean }) => SqliteDb };
    return new Database(dbPath, { readonly: true });
  }
}

/** API key, or the OAuth access token. Refresh material is never read. */
function bearerFromStoredValue(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const entry = parsed as { type?: unknown; key?: unknown; access?: unknown };
  if (entry.type === "api" && typeof entry.key === "string" && entry.key.length > 0) return entry.key;
  if (entry.type === "oauth" && typeof entry.access === "string" && entry.access.length > 0) return entry.access;
  return null;
}

/**
 * Active v2 credential. `opencode-go` wins over `opencode`. Newest row wins
 * within one integration. A missing or unreadable database is no credential.
 */
function readV2Bearer(env: NodeJS.Dict<string>, home: string): string | null {
  const dbPath = openCodeGoDbPath(env, home);
  if (!fsSync.existsSync(dbPath)) return null;
  let db: SqliteDb | undefined;
  try {
    db = openReadonlySqlite(dbPath);
    const rows = db.prepare(
      "SELECT integration_id, value FROM credential WHERE active = 1 AND integration_id IN ('opencode-go', 'opencode') ORDER BY rowid DESC",
    ).all();
    const chosen = new Map<string, string>();
    for (const row of rows) {
      const id = row.integration_id;
      if (typeof id !== "string" || chosen.has(id)) continue;
      const bearer = bearerFromStoredValue(row.value);
      if (bearer) chosen.set(id, bearer);
    }
    return chosen.get("opencode-go") ?? chosen.get("opencode") ?? null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* a failed open has nothing to close */ }
  }
}

function readLegacyBearer(env: NodeJS.Dict<string>, home: string): string | null {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(openCodeGoAuthPath(env, home), "utf8")) as Record<string, unknown>;
    const entry = (parsed["opencode-go"] ?? parsed["opencode"]) as { type?: unknown; key?: unknown } | undefined;
    if (!entry || entry.type !== "api" || typeof entry.key !== "string" || entry.key.length === 0) return null;
    return entry.key;
  } catch {
    return null;
  }
}

/**
 * Consent-gated: poll() runs only when the provider is in enabledProviders,
 * which the enable flow records as explicit consent. One read, in-memory
 * only, never written or logged. Env wins so a host can avoid file access.
 * v2's database wins over the legacy file, which v2 no longer updates.
 */
function readBearerToken(env: NodeJS.Dict<string> = process.env, home = os.homedir()): string {
  const fromEnv = env.OPENCODE_API_KEY;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const fromV2 = readV2Bearer(env, home);
  if (fromV2) return fromV2;
  const fromLegacy = readLegacyBearer(env, home);
  if (fromLegacy) return fromLegacy;
  throw new Error("opencode-go: missing API key in auth file");
}

type MonthlyFields = Pick<ParsedQuota, "monthlyPct" | "monthlyResetsAt" | "monthlyStatus" | "monthlyKind">;

// `rate-limited` is the binding state, not a failure: it is exactly the
// reading issue 109 needed. Anything unreadable fails closed.
function parseMonthly(usage: Record<string, unknown>): MonthlyFields {
  const monthly = usage.monthly;
  if (typeof monthly !== "object" || monthly === null) return {};
  const m = monthly as Record<string, unknown>;
  if (m.status !== "ok" && m.status !== "rate-limited") {
    throw new Error("opencode-go: unknown monthly status");
  }
  const percent = m.percent;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) {
    throw new Error("opencode-go: bad monthly pct");
  }
  const resetsMs = Date.parse(String(m.resetsAt ?? ""));
  if (!Number.isFinite(resetsMs)) {
    throw new Error("opencode-go: bad monthly reset");
  }
  const exhausted = m.status === "rate-limited" || percent > 100;
  return {
    monthlyKind: "included",
    monthlyStatus: exhausted ? "exhausted" : "ok",
    monthlyPct: exhausted ? 100 : percent,
    monthlyResetsAt: new Date(resetsMs).toISOString(),
  };
}

export function parseOpencodeGoUsage(body: unknown, now = new Date()): ParsedQuota {
  const usage = (body as { usage?: unknown } | null)?.usage;
  if (typeof usage !== "object" || usage === null) {
    throw new Error("opencode-go: weekly usage not found");
  }
  const weekly = (usage as Record<string, unknown>).weekly;
  if (typeof weekly !== "object" || weekly === null) {
    throw new Error("opencode-go: weekly usage not found");
  }
  if ((weekly as Record<string, unknown>).status !== "ok") {
    throw new Error("opencode-go: usage status not ok");
  }
  const usedPct = (weekly as Record<string, unknown>).percent;
  if (typeof usedPct !== "number" || !Number.isFinite(usedPct) || usedPct < 0 || usedPct > 100) {
    throw new Error("opencode-go: bad weekly pct");
  }
  const resetsMs = Date.parse(String((weekly as Record<string, unknown>).resetsAt ?? ""));
  if (!Number.isFinite(resetsMs)) {
    throw new Error("opencode-go: bad weekly reset");
  }
  const rolling = (usage as Record<string, unknown>).rolling;
  if (typeof rolling !== "object" || rolling === null) {
    throw new Error("opencode-go: rolling usage not found");
  }
  if ((rolling as Record<string, unknown>).status !== "ok") {
    throw new Error("opencode-go: usage status not ok");
  }
  const sessionPct = (rolling as Record<string, unknown>).percent;
  if (typeof sessionPct !== "number" || !Number.isFinite(sessionPct) || sessionPct < 0 || sessionPct > 100) {
    throw new Error("opencode-go: bad rolling pct");
  }
  const rollingResetsMs = Date.parse(String((rolling as Record<string, unknown>).resetsAt ?? ""));
  const fiveHourResetsAt = Number.isFinite(rollingResetsMs)
    ? new Date(rollingResetsMs).toISOString()
    : undefined;
  const monthly = parseMonthly(usage as Record<string, unknown>);
  return {
    provider: "opencode-go",
    plan: "unknown",
    weeklyPct: usedPct,
    fiveHourPct: sessionPct,
    ...(fiveHourResetsAt ? { fiveHourResetsAt } : {}),
    resetsAt: new Date(resetsMs).toISOString(),
    periodStart: new Date(resetsMs - 7 * 86400000).toISOString(),
    source: "api",
    fetchedAt: now.toISOString(),
    ...monthly,
  };
}

export const opencodeGoAdapter = {
  id: "opencode-go",
  requiresAuth: "OpenCode CLI login for your version (read only after you enable opencode-go)",
  async poll(): Promise<ParsedQuota> {
    const bearer = readBearerToken();
    const adapter = adapterSignal("opencode-go");
    const signals = [AbortSignal.timeout(POLL_TIMEOUT_MS)];
    if (adapter) signals.push(adapter);
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.any(signals),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`opencode-go: unauthorized (${res.status})`);
    }
    if (res.status === 429) {
      throw new Error("opencode-go: rate limit (429)");
    }
    if (!res.ok) {
      throw new Error(`opencode-go: usage request failed with status ${res.status}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(await res.text());
    } catch {
      throw new Error("opencode-go: weekly usage not found");
    }
    return parseOpencodeGoUsage(body);
  },
};
