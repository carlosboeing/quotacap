import os from "node:os";
import path from "node:path";
import { readJsonFile, getJson, postForm, persistCreds, HttpError } from "./core.js";
import type { Quota } from "./types.js";

export function parseCodexUsage(body: any, now = new Date()): Quota {
  const rl = body?.rate_limit ?? {};
  const win = rl.secondary_window ?? rl.primary_window;
  if (!win) throw new Error("codex: no rate-limit window in response");
  const resetsAt = new Date(win.reset_at * 1000).toISOString();
  const periodStart = new Date((win.reset_at - win.limit_window_seconds) * 1000).toISOString();
  return {
    provider: "codex",
    plan: body.plan_type ?? "unknown",
    usedPct: win.used_percent ?? 0,
    resetsAt,
    periodStart,
    raw: JSON.stringify(body),
    source: "api",
    fetchedAt: now.toISOString(),
  };
}

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

export const codexAdapter = {
  id: "codex",
  requiresAuth: "~/.codex/auth.json (codex login)",
  async poll(): Promise<Quota> {
    const authFile = path.join(codexHome(), "auth.json");
    const auth = await readJsonFile<{ tokens?: { access_token?: string; refresh_token?: string; account_id?: string } }>(
      authFile
    );
    const at = auth.tokens?.access_token;
    if (!at) throw new Error("codex: no access_token in auth.json — run codex login");
    const headers: Record<string, string> = { Authorization: `Bearer ${at}`, "User-Agent": "quotacap" };
    if (auth.tokens?.account_id) headers["ChatGPT-Account-Id"] = auth.tokens.account_id;
    try {
      return parseCodexUsage(await getJson(USAGE_URL, headers));
    } catch (e) {
      if ((e as HttpError).status !== 401) throw e;
      const rf = auth.tokens?.refresh_token;
      if (!rf) throw e;
      const tok = await postForm(REFRESH_URL, { grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: rf });
      await persistCreds<Record<string, unknown> & { tokens?: Record<string, unknown> }>(authFile, (cur) => {
        const tokens = { ...(cur.tokens ?? {}), };
        if (tok.access_token) tokens.access_token = tok.access_token;
        if (tok.refresh_token) tokens.refresh_token = tok.refresh_token;
        return { ...cur, tokens, last_refresh: new Date().toISOString() };
      });
      return parseCodexUsage(await getJson(USAGE_URL, { ...headers, Authorization: `Bearer ${tok.access_token}` }));
    }
  },
};
