import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseResetText } from "./parse.js";
import { runPty, stripAnsi } from "./pty.js";
import { adapterSignal } from "../runtime/spawn.js";
import type { ParsedQuota } from "./types.js";

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.ai";
const DEFAULT_BASE_URL = "https://api.kimi.ai/coding/v1";
const POLL_TIMEOUT_MS = 8000;

export function kimiProbeDir(): string {
  return path.join(process.env.QUOTACAP_HOME ?? os.homedir(), ".quotacap", "kimi-probe");
}

type MonthlyFields = Pick<ParsedQuota, "monthlyPct" | "monthlyResetsAt" | "monthlyStatus" | "monthlyKind">;

export function parseKimiTui(text: string, now = new Date()): ParsedQuota {
  const cleaned = stripAnsi(text);
  const weeklyRe = /Weekly limit\s+[^0-9]*(\d+)%\s+used\s+resets\s+(in\s+[^\n│\r]+)/i;
  const fiveRe = /5h limit\s+[^0-9]*(\d+)%\s+used\s+resets\s+(in\s+[^\n│\r]+)/i;
  const w = cleaned.match(weeklyRe);
  if (!w) throw new Error("kimi: weekly limit not found in TUI output");
  const f = cleaned.match(fiveRe);
  let sessionPct: number | null = null;
  let fiveRaw: string | null = null;
  if (f) {
    sessionPct = parseInt(f[1], 10);
    fiveRaw = f[2].trim();
  } else {
    const fallback = cleaned.match(/5h limit[^\d%]*(\d+)%\s+used/i);
    if (fallback) sessionPct = parseInt(fallback[1], 10);
  }
  if (sessionPct === null) throw new Error("kimi: 5h limit not found in TUI output");
  const usedPct = parseInt(w[1], 10);
  if (!Number.isFinite(usedPct) || usedPct < 0 || usedPct > 100)
    throw new Error("kimi: bad weekly pct");
  if (!Number.isFinite(sessionPct) || sessionPct < 0 || sessionPct > 100)
    throw new Error("kimi: bad 5h pct");
  const weeklyRaw = w[2].trim();
  const weeklyIso = parseResetText(`resets ${weeklyRaw}`, now);
  if (!weeklyIso) throw new Error(`kimi: bad weekly reset "${weeklyRaw}"`);
  if (fiveRaw) {
    const fiveIso = parseResetText(`resets ${fiveRaw}`, now);
    if (!fiveIso) throw new Error(`kimi: bad 5h reset "${fiveRaw}"`);
  }

  let plan = "unknown";
  const paren = cleaned.match(/Weekly limit\s*\(([^)]+)\)/i);
  if (paren) {
    plan = paren[1].trim().toLowerCase();
  } else {
    const lvl = cleaned.match(/level\s*[:\-]\s*([A-Za-z0-9_\-]+)/i);
    if (lvl) plan = lvl[1].trim().toLowerCase().replace(/^level_/i, "");
  }

  // Optional monthly window
  const m = cleaned.match(/Monthly limit[^\d%]*(\d+)%\s+used(?:\s+resets\s+(in\s+[^\n│\r]+|[^\n│\r]+))?/i);
  let monthlyFields: MonthlyFields = {};
  if (m) {
    const monthlyPct = parseInt(m[1], 10);
    if (Number.isFinite(monthlyPct) && monthlyPct >= 0) {
      const exhausted = monthlyPct >= 100;
      const rawReset = m[2]?.trim();
      const textToParse = rawReset
        ? rawReset.startsWith("in ")
          ? `resets ${rawReset}`
          : `resets in ${rawReset}`
        : "";
      const resetIso = textToParse ? parseResetText(textToParse, now) : undefined;
      monthlyFields = {
        monthlyKind: "included",
        monthlyStatus: exhausted ? "exhausted" : "ok",
        monthlyPct: exhausted ? 100 : Math.min(100, monthlyPct),
        monthlyResetsAt: resetIso,
      };
    }
  }

  const periodStart = new Date(new Date(weeklyIso).getTime() - 7 * 86400000).toISOString();
  return {
    provider: "kimi",
    plan,
    weeklyPct: usedPct,
    fiveHourPct: sessionPct,
    resetsAt: weeklyIso,
    periodStart,
    source: "tui",
    fetchedAt: now.toISOString(),
    raw: cleaned.slice(0, 4096),
    ...monthlyFields,
  };
}

// Exhaustion comes from the raw ratio; only the displayed pct is rounded, and
// capped at 99 below full so a rounded 100 never reads as an empty window.
// An unreadable reset stays undefined: the monthly window is independent of
// the weekly one, so the weekly reset is no stand-in for it.
function monthlyFromRatio(ratio: number, resetRaw: unknown): MonthlyFields {
  const exhausted = ratio >= 1;
  const resetsMs = Date.parse(String(resetRaw ?? ""));
  return {
    monthlyKind: "included",
    monthlyStatus: exhausted ? "exhausted" : "ok",
    monthlyPct: exhausted ? 100 : Math.min(99, Math.max(0, Math.round(ratio * 100))),
    monthlyResetsAt: Number.isFinite(resetsMs) ? new Date(resetsMs).toISOString() : undefined,
  };
}

function parseKimiApiMonthly(
  u: Record<string, unknown>,
  legacyUsages: Record<string, unknown> | undefined,
): MonthlyFields {
  // 1. Check limits array for an explicit monthly duration (>= 28 days)
  if (Array.isArray(u.limits)) {
    for (const item of u.limits) {
      if (item && typeof item === "object") {
        const win = (item as Record<string, unknown>).window as Record<string, unknown> | undefined;
        const unit = typeof win?.timeUnit === "string" ? win.timeUnit : "";
        const dur = Number(win?.duration);
        const isMonthly =
          unit === "TIME_UNIT_MONTH" ||
          (unit === "TIME_UNIT_DAY" && dur >= 28) ||
          (unit === "TIME_UNIT_MINUTE" && dur >= 40320);
        if (isMonthly) {
          const detail = (item as Record<string, unknown>).detail as Record<string, unknown> | undefined;
          if (detail && typeof detail === "object") {
            const used = Number(detail.used);
            const limit = Number(detail.limit);
            if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
              return monthlyFromRatio(used / limit, detail.resetTime);
            }
          }
        }
      }
    }
  }

  // 2. Check usages.limit_month_total (Moonshot CLI schema)
  if (legacyUsages && typeof legacyUsages === "object") {
    const lMonth = legacyUsages.limit_month_total as Record<string, unknown> | undefined;
    if (lMonth && typeof lMonth === "object") {
      const ratio = Number(lMonth.used_ratio);
      if (Number.isFinite(ratio) && ratio >= 0) {
        return monthlyFromRatio(ratio, lMonth.reset_time);
      }
    }
  }

  // 3. Check subscriptionBalance / subscription_balance (Moonshot web gateway schema)
  const subBal = (u.subscriptionBalance ?? u.subscription_balance) as Record<string, unknown> | undefined;
  if (subBal && typeof subBal === "object") {
    const ratio = Number(subBal.amountUsedRatio ?? subBal.amount_used_ratio);
    if (Number.isFinite(ratio) && ratio >= 0) {
      return monthlyFromRatio(ratio, subBal.expireTime ?? subBal.expire_time);
    }
  }

  return {};
}

export function parseKimiApiUsage(usagesBody: unknown, meBody?: unknown, now = new Date()): ParsedQuota {
  if (typeof usagesBody !== "object" || usagesBody === null) {
    throw new Error("kimi: invalid api response");
  }
  const u = usagesBody as Record<string, unknown>;

  // 1. Weekly window (from usage object)
  let weeklyPct: number | null = null;
  let resetsAt: string | null = null;

  const usage = u.usage as Record<string, unknown> | undefined;
  if (usage && typeof usage === "object") {
    const used = Number(usage.used);
    const limit = Number(usage.limit);
    if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
      weeklyPct = Math.round((used / limit) * 100);
    }
    if (typeof usage.resetTime === "string" && usage.resetTime.length > 0) {
      const parsed = Date.parse(usage.resetTime);
      if (Number.isFinite(parsed)) resetsAt = new Date(parsed).toISOString();
    }
  }

  // 2. 5-hour window (from limits array)
  let sessionPct: number | null = null;
  if (Array.isArray(u.limits)) {
    for (const item of u.limits) {
      if (item && typeof item === "object") {
        const detail = (item as Record<string, unknown>).detail as Record<string, unknown> | undefined;
        if (detail && typeof detail === "object") {
          const used = Number(detail.used);
          const limit = Number(detail.limit);
          if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
            sessionPct = Math.round((used / limit) * 100);
            break;
          }
        }
      }
    }
  }

  // Fallback to legacy usages object if limits/usage were omitted
  const legacyUsages = u.usages as Record<string, unknown> | undefined;
  if (legacyUsages && typeof legacyUsages === "object") {
    if (weeklyPct === null) {
      const l7d = legacyUsages.limit_7d as Record<string, unknown> | undefined;
      if (l7d && typeof l7d.used_ratio === "number") {
        weeklyPct = Math.round(l7d.used_ratio * 100);
      }
      if (l7d && typeof l7d.reset_time === "string" && !resetsAt) {
        const parsed = Date.parse(l7d.reset_time);
        if (Number.isFinite(parsed)) resetsAt = new Date(parsed).toISOString();
      }
    }
    if (sessionPct === null) {
      const l5h = legacyUsages.limit_5h as Record<string, unknown> | undefined;
      if (l5h && typeof l5h.used_ratio === "number") {
        sessionPct = Math.round(l5h.used_ratio * 100);
      }
    }
  }

  if (weeklyPct === null || weeklyPct < 0 || weeklyPct > 100) {
    throw new Error("kimi: weekly pct not found in api response");
  }
  if (sessionPct === null || sessionPct < 0 || sessionPct > 100) {
    throw new Error("kimi: 5h pct not found in api response");
  }
  if (!resetsAt || Number.isNaN(new Date(resetsAt).getTime())) {
    throw new Error("kimi: weekly reset not found in api response");
  }

  // 3. Plan identity (from meBody)
  let plan = "unknown";
  if (meBody && typeof meBody === "object") {
    const me = meBody as Record<string, unknown>;
    if (typeof me.user_level_name === "string" && me.user_level_name.trim().length > 0) {
      plan = me.user_level_name.trim().toLowerCase();
    }
  }

  // 4. Optional monthly quota (from limit_month_total, limits, or subscriptionBalance)
  const monthly = parseKimiApiMonthly(u, legacyUsages);

  const periodStart = new Date(new Date(resetsAt).getTime() - 7 * 86400000).toISOString();
  return {
    provider: "kimi",
    plan,
    weeklyPct,
    fiveHourPct: sessionPct,
    resetsAt,
    periodStart,
    source: "api",
    fetchedAt: now.toISOString(),
    ...monthly,
  };
}

export interface KimiStoredCreds {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
  scope?: string;
}

export interface KimiAuthContext {
  token: string;
  credPath?: string;
  creds?: KimiStoredCreds;
  deviceId?: string;
  oauthHost: string;
  baseUrl: string;
}

const KIMI_PROVIDER_TABLE = 'providers."managed:kimi-code"';

export interface KimiProviderConfig {
  baseUrl?: string;
  oauthHost?: string;
  key?: string;
}

/**
 * Reads the Kimi provider's own entries from config.toml. Only keys inside
 * `[providers."managed:kimi-code"]` and its `.oauth` sub-table count; comments
 * and every other table are ignored.
 */
export function readKimiProviderConfig(content: string): KimiProviderConfig {
  const out: KimiProviderConfig = {};
  let table = "";
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const header = line.match(/^\[\s*([^[\]]+?)\s*\]\s*(?:#.*)?$/);
      table = header ? header[1] : "";
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"\s*(?:#.*)?$/);
    if (!kv || !kv[2].trim()) continue;
    const [, k, v] = kv;
    if (table === KIMI_PROVIDER_TABLE && k === "base_url") out.baseUrl = v.trim();
    if (table === `${KIMI_PROVIDER_TABLE}.oauth` && k === "oauth_host") out.oauthHost = v.trim();
    if (table === `${KIMI_PROVIDER_TABLE}.oauth` && k === "key") out.key = v.trim();
  }
  return out;
}

export function resolveKimiAuth(
  env: Record<string, string | undefined> = process.env,
  customKimiDir?: string,
): KimiAuthContext | null {
  const fromEnv = env.KIMI_CODE_API_KEY || env.KIMI_API_KEY;
  if (fromEnv && fromEnv.trim()) {
    return {
      token: fromEnv.trim(),
      oauthHost: env.KIMI_CODE_OAUTH_HOST ?? DEFAULT_OAUTH_HOST,
      baseUrl: env.KIMI_CODE_BASE_URL ?? DEFAULT_BASE_URL,
    };
  }

  const kimiDir = customKimiDir ?? path.join(os.homedir(), ".kimi-code");
  let deviceId = "";
  try {
    deviceId = fs.readFileSync(path.join(kimiDir, "device_id"), "utf8").trim();
  } catch {}

  let config: KimiProviderConfig = {};
  try {
    config = readKimiProviderConfig(fs.readFileSync(path.join(kimiDir, "config.toml"), "utf8"));
  } catch {}

  // Explicit environment overrides win; otherwise only the Kimi provider's own
  // table supplies hosts, so a token is never paired with another provider's URL.
  const oauthHost = env.KIMI_CODE_OAUTH_HOST ?? config.oauthHost ?? DEFAULT_OAUTH_HOST;
  const baseUrl = env.KIMI_CODE_BASE_URL ?? config.baseUrl ?? DEFAULT_BASE_URL;
  let credPath: string | null = null;

  if (config.key) {
    // The config names its credential: use exactly that file or nothing.
    const candidate = path.join(kimiDir, "credentials", `${path.basename(config.key)}.json`);
    if (!fs.existsSync(candidate)) return null;
    credPath = candidate;
  } else {
    // No reference in config: scan credentials directory for newest .json file
    const credsDir = path.join(kimiDir, "credentials");
    try {
      const files = fs.readdirSync(credsDir).filter((f) => f.endsWith(".json"));
      if (files.length > 0) {
        files.sort((a, b) => {
          const sA = fs.statSync(path.join(credsDir, a)).mtimeMs;
          const sB = fs.statSync(path.join(credsDir, b)).mtimeMs;
          return sB - sA;
        });
        credPath = path.join(credsDir, files[0]);
      }
    } catch {}
  }

  if (!credPath) return null;

  try {
    const creds = JSON.parse(fs.readFileSync(credPath, "utf8")) as KimiStoredCreds;
    const hasToken =
      (typeof creds.access_token === "string" && creds.access_token.trim().length > 0) ||
      (typeof creds.refresh_token === "string" && creds.refresh_token.trim().length > 0);
    if (hasToken) {
      return {
        token: creds.access_token?.trim() ?? "",
        credPath,
        creds,
        deviceId: deviceId || undefined,
        oauthHost,
        baseUrl,
      };
    }
  } catch {}

  return null;
}

export async function refreshKimiOAuthToken(
  oauthHost: string,
  refreshToken: string,
  deviceId?: string,
  signal?: AbortSignal,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const url = `${oauthHost.replace(/\/+$/, "")}/api/oauth/token`;
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": "kimi-code-cli/2.0.2",
    "X-Msh-Version": "2.0.2",
  };
  if (deviceId) headers["X-Msh-Device-Id"] = deviceId;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: body.toString(),
    signal,
  });

  if (!res.ok) {
    throw new Error(`kimi: token refresh failed (HTTP ${res.status})`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  if (typeof data.access_token !== "string" || !data.access_token.trim()) {
    throw new Error("kimi: refresh response missing access_token");
  }

  return {
    access_token: data.access_token.trim(),
    refresh_token: typeof data.refresh_token === "string" && data.refresh_token.trim() ? data.refresh_token.trim() : undefined,
    expires_in: typeof data.expires_in === "number" ? data.expires_in : undefined,
  };
}

/** A refresh rotated the tokens but the result could not be saved for the Kimi CLI. */
export class KimiCredentialWriteError extends Error {
  constructor(credPath: string, cause: unknown) {
    super(`kimi: refreshed token could not be saved to ${credPath} (${(cause as Error)?.message ?? cause}); run \`kimi login\``);
    this.name = "KimiCredentialWriteError";
  }
}

function readCredsFile(credPath: string): { raw: string; creds: KimiStoredCreds } | null {
  try {
    const raw = fs.readFileSync(credPath, "utf8");
    return { raw, creds: JSON.parse(raw) as KimiStoredCreds };
  } catch {
    return null;
  }
}

export async function ensureFreshKimiToken(ctx: KimiAuthContext, signal?: AbortSignal): Promise<string> {
  if (!ctx.credPath || !ctx.creds) return ctx.token;

  const nowSec = Math.floor(Date.now() / 1000);
  const isFresh = (c: KimiStoredCreds) => !!c.access_token && (c.expires_at ?? 0) > nowSec + 60;

  if (isFresh(ctx.creds)) {
    return ctx.creds.access_token!;
  }

  // The Kimi CLI owns this file: re-read it, and adopt a token it refreshed since we loaded it.
  const before = readCredsFile(ctx.credPath);
  if (before && before.creds.access_token !== ctx.creds.access_token && isFresh(before.creds)) {
    ctx.creds = before.creds;
    ctx.token = before.creds.access_token!;
    return ctx.token;
  }
  const creds = before?.creds ?? ctx.creds;

  if (!creds.refresh_token) {
    if (creds.access_token) return creds.access_token;
    throw new Error("kimi: missing refresh_token");
  }

  const refreshed = await refreshKimiOAuthToken(ctx.oauthHost, creds.refresh_token, ctx.deviceId, signal);
  const next: KimiStoredCreds = {
    ...creds,
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? creds.refresh_token,
    expires_at: nowSec + (refreshed.expires_in ?? 900),
  };
  ctx.creds = next;
  ctx.token = refreshed.access_token;

  // Another writer changed the file during the refresh: keep its copy rather than overwrite it.
  if (readCredsFile(ctx.credPath)?.raw !== before?.raw) return ctx.token;

  // Atomic replace: write a private temp file beside the original, then rename over it.
  const tmp = `${ctx.credPath}.quotacap-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, ctx.credPath);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw new KimiCredentialWriteError(ctx.credPath, e);
  }

  return ctx.token;
}

export async function pollKimiApi(ctx: KimiAuthContext): Promise<ParsedQuota> {
  const adapter = adapterSignal("kimi");
  const timeout = AbortSignal.timeout(POLL_TIMEOUT_MS);
  const signal = adapter ? AbortSignal.any([adapter, timeout]) : timeout;

  const token = await ensureFreshKimiToken(ctx, signal);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "kimi-code-cli/2.0.2",
    "X-Msh-Version": "2.0.2",
  };
  if (ctx.deviceId) headers["X-Msh-Device-Id"] = ctx.deviceId;

  const usagesUrl = `${ctx.baseUrl.replace(/\/+$/, "")}/usages`;
  let usagesRes = await fetch(usagesUrl, { headers, signal });

  // On 401, attempt one forced refresh if refresh_token is available
  if (usagesRes.status === 401 && ctx.credPath && ctx.creds?.refresh_token) {
    ctx.creds.expires_at = 0;
    const freshToken = await ensureFreshKimiToken(ctx, signal);
    headers.Authorization = `Bearer ${freshToken}`;
    usagesRes = await fetch(usagesUrl, { headers, signal });
  }

  if (!usagesRes.ok) {
    throw new Error(`kimi: usage request failed (HTTP ${usagesRes.status})`);
  }

  const usagesBody = await usagesRes.json();

  let meBody: unknown = undefined;
  try {
    const meUrl = `${ctx.baseUrl.replace(/\/+$/, "")}/me`;
    const meRes = await fetch(meUrl, { headers, signal });
    if (meRes.ok) {
      meBody = await meRes.json();
    }
  } catch {}

  return parseKimiApiUsage(usagesBody, meBody);
}

export async function pollKimiPty(): Promise<ParsedQuota> {
  const cwd = kimiProbeDir();
  fs.mkdirSync(cwd, { recursive: true });
  const transcript = await runPty({
    file: "kimi",
    args: [],
    cols: 140,
    rows: 35,
    cwd,
    readyRegex: /Welcome to Kimi Code|context:/i,
    readyTimeoutMs: 8000,
    preReadyResponse: {
      match: /Trust this folder\?/i,
      reply: "\r",
    },
    input: "/usage\r",
    completionRegex: /Weekly limit[\s\S]*?5h limit|5h limit[\s\S]*?Weekly limit/i,
    timeoutMs: 8000,
    maxBytes: 256 * 1024,
    signal: adapterSignal("kimi"),
    label: "kimi",
  });
  return parseKimiTui(transcript);
}

export const kimiAdapter = {
  id: "kimi",
  requiresAuth: "kimi login (CLI owns credentials)",
  async poll(): Promise<ParsedQuota> {
    const authCtx = resolveKimiAuth();
    if (authCtx) {
      try {
        return await pollKimiApi(authCtx);
      } catch (e) {
        // A lost rotated token leaves the CLI logged out: report it, do not mask it with the PTY path.
        if (e instanceof KimiCredentialWriteError) throw e;
      }
    }
    return pollKimiPty();
  },
};
