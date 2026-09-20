// Consented exception to credential-free polling: reads the OpenCode auth
// key in-memory, only after `providers enable opencode-go` records consent.
// The static gate pins the auth-file literal to this adapter plus the
// generated dashboard bundle — see tests/adapters/credential-free.test.ts.
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { adapterSignal } from "../runtime/spawn.js";
import type { ParsedQuota } from "./types.js";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const POLL_TIMEOUT_MS = 8000;

export const OPENCODE_GO_CONSENT_NOTICE =
  "QuotaCap will read the API key OpenCode already stored when you ran `opencode auth login -p opencode-go` (`~/.local/share/opencode/auth.json`, `opencode-go` → `opencode` fallback). It is read in-memory, read-only once per poll (every 15 minutes by default). It is sent only as `Authorization: Bearer` to `https://opencode.ai/zen/go/v1/usage` to fetch `rolling/weekly/monthly` `percent` + `resetsAt`. It is never used to make chat or model requests, never written or rotated, never stored in the `quotacap` DB, never returned by the API or MCP, and never logged (errors show `[redacted]`). Revoke at `https://opencode.ai/auth` or `opencode providers logout opencode-go` and run `quotacap providers disable opencode-go` to stop polling. If you prefer no file access, set `OPENCODE_API_KEY` instead.";

export function openCodeGoAuthPath(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
}

/** Detection is existence only — no content read before enablement. */
export function opencodeGoDetected(): boolean {
  try {
    return fsSync.existsSync(openCodeGoAuthPath());
  } catch {
    return false;
  }
}

/**
 * Consent-gated: poll() runs only when the provider is in enabledProviders,
 * which the enable flow records as explicit consent. One read, in-memory
 * only, never written or logged. Env wins so a host can avoid file access.
 */
function readBearerToken(env: NodeJS.Dict<string> = process.env): string {
  const fromEnv = env.OPENCODE_API_KEY;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fsSync.readFileSync(openCodeGoAuthPath(), "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("opencode-go: missing API key in auth file");
  }
  const entry = (parsed["opencode-go"] ?? parsed["opencode"]) as { type?: unknown; key?: unknown } | undefined;
  if (
    !entry ||
    entry.type !== "api" ||
    typeof entry.key !== "string" ||
    !entry.key.startsWith("sk-")
  ) {
    throw new Error("opencode-go: missing API key in auth file");
  }
  return entry.key;
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
  return {
    provider: "opencode-go",
    plan: "unknown",
    usedPct,
    sessionPct,
    resetsAt: new Date(resetsMs).toISOString(),
    periodStart: new Date(resetsMs - 7 * 86400000).toISOString(),
    source: "api",
    fetchedAt: now.toISOString(),
  };
}

export const opencodeGoAdapter = {
  id: "opencode-go",
  requiresAuth: "opencode auth login -p opencode-go (read only after you enable opencode-go)",
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
