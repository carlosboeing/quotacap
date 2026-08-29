import os from "node:os";
import path from "node:path";
import { readJsonFile, getJson, postForm, persistCreds } from "./core.js";
import type { Quota } from "./types.js";

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const REFRESH_URL = "https://auth.x.ai/oauth2/token";
const CLIENT_VERSION = "1.0.0";

export function parseGrokUsage(body: any, now = new Date()): Quota {
  const cfg = body?.config;
  if (!cfg) throw new Error("grok: no config in billing response");
  const pct = cfg.creditUsagePercent;
  if (typeof pct !== "number") throw new Error("grok: creditUsagePercent missing");
  const period = cfg.currentPeriod ?? {};
  return {
    provider: "grok",
    plan: body?.subscriptionTier ?? "unknown",
    usedPct: pct,
    resetsAt: period.end ?? new Date(now.getTime() + 7 * 86400000).toISOString(),
    periodStart: period.start ?? new Date(now.getTime() - 7 * 86400000).toISOString(),
    raw: JSON.stringify(body),
    source: "api",
    fetchedAt: now.toISOString(),
  };
}

interface GrokEntry {
  refresh_token?: string;
  oidc_client_id?: string;
  expires_at?: string;
}

function grokHome(): string {
  return process.env.GROK_HOME ?? path.join(os.homedir(), ".grok");
}

async function loadEntry(): Promise<{ file: string; entry: GrokEntry }> {
  const file = path.join(grokHome(), "auth.json");
  const auth = await readJsonFile<Record<string, GrokEntry>>(file);
  for (const entry of Object.values(auth)) {
    if (entry.refresh_token) return { file, entry };
  }
  throw new Error("grok: no refresh_token in auth.json — run `grok login`");
}

export const grokAdapter = {
  id: "grok",
  requiresAuth: "~/.grok/auth.json (grok login)",
  async poll(): Promise<Quota> {
    const { file, entry } = await loadEntry();
    const tok = await postForm(REFRESH_URL, {
      grant_type: "refresh_token",
      client_id: entry.oidc_client_id ?? "",
      refresh_token: entry.refresh_token ?? "",
    });
    if (!tok.access_token) throw new Error("grok: refresh returned no access_token");
    await persistCreds<Record<string, GrokEntry>>(file, (cur) => {
      const next: Record<string, GrokEntry> = { ...cur };
      for (const key of Object.keys(next)) {
        if (next[key].refresh_token) next[key] = { ...next[key], refresh_token: tok.refresh_token ?? next[key].refresh_token, expires_at: tok.expires_at ?? next[key].expires_at };
      }
      return next;
    });
    const body = await getJson(BILLING_URL, {
      Authorization: `Bearer ${tok.access_token}`,
      Accept: "application/json",
      "x-grok-client-version": CLIENT_VERSION,
      "x-grok-client-surface": "grok-build",
      "X-XAI-Token-Auth": "xai-grok-cli",
    });
    return parseGrokUsage(body);
  },
};
