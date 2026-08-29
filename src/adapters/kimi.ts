import os from "node:os";
import path from "node:path";
import { readJsonFile, getJson, postForm, persistCreds, HttpError } from "./core.js";
import type { Quota } from "./types.js";

const USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const REFRESH_URL = "https://auth.kimi.com/api/oauth/token";
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";

export function parseKimiUsage(body: any, now = new Date()): Quota {
  const usage = body?.usage;
  if (!usage) throw new Error("kimi: no usage in response");
  const limit = Number(usage.limit);
  const used = Number(usage.used);
  if (!(limit > 0) || Number.isNaN(used)) throw new Error("kimi: bad usage numbers");
  const resetsAt = usage.resetTime;
  if (Number.isNaN(new Date(resetsAt).getTime())) throw new Error("kimi: bad resetTime");
  const periodStart = new Date(new Date(resetsAt).getTime() - 7 * 86400000).toISOString();
  const level = body?.user?.membership?.level;
  return {
    provider: "kimi",
    plan: level ? String(level).replace(/^LEVEL_/, "").toLowerCase() : "unknown",
    usedPct: Math.round((used / limit) * 100),
    resetsAt,
    periodStart,
    raw: JSON.stringify(body),
    source: "api",
    fetchedAt: now.toISOString(),
  };
}

interface KimiCreds {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
  scope?: string;
}

function credsCandidates(): string[] {
  const home = process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), ".kimi-code");
  const legacy = path.join(os.homedir(), ".kimi", "credentials", "kimi-code.json");
  return [path.join(home, "credentials", "kimi-code.json"), legacy];
}

async function loadCreds(): Promise<{ file: string; creds: KimiCreds }> {
  for (const file of credsCandidates()) {
    try {
      return { file, creds: await readJsonFile<KimiCreds>(file) };
    } catch {
      continue;
    }
  }
  throw new Error("kimi: no credentials file — run `kimi login`");
}

function isFreshExpiry(raw: unknown): boolean {
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return false;
  const ms = v < 1e12 ? v * 1000 : v; // CLI stores seconds; legacy rows from earlier quotas are ms
  return ms > Date.now();
}

async function refreshAndPersist(file: string, creds: KimiCreds): Promise<string> {
  if (!creds.refresh_token) throw new Error("kimi: no refresh_token — run `kimi login`");
  const tok = await postForm(REFRESH_URL, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: creds.refresh_token,
  });
  if (!tok.access_token) throw new Error("kimi: refresh returned no access_token");
  await persistCreds<KimiCreds>(file, (cur) => ({
    ...cur,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? cur.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (Number(tok.expires_in) || 3600),
    token_type: tok.token_type ?? cur.token_type,
    scope: tok.scope ?? cur.scope,
  }));
  return String(tok.access_token);
}

export const kimiAdapter = {
  id: "kimi",
  requiresAuth: "~/.kimi-code/credentials/kimi-code.json (kimi login)",
  async poll(): Promise<Quota> {
    const { file, creds } = await loadCreds();
    let token = creds.access_token ?? "";
    let justRefreshed = false;
    if (!token) throw new Error("kimi: no access_token — run `kimi login`");
    if (!isFreshExpiry(creds.expires_at)) {
      token = await refreshAndPersist(file, creds);
      justRefreshed = true;
    }
    const call = (t: string) =>
      getJson(USAGE_URL, { Authorization: `Bearer ${t}` }).then(parseKimiUsage);
    try {
      return await call(token);
    } catch (e) {
      if ((e as HttpError).status !== 401 || justRefreshed) throw e;
      const fresh = await refreshAndPersist(file, creds);
      return await call(fresh);
    }
  },
};
