import { parseResetText } from "./parse.js";
import type { Quota } from "./types.js";

export function parseManualUsage(provider: string, text: string, now = new Date()): Quota {
  const m = text.match(/(\d+)% used/);
  const usedPct = m ? parseInt(m[1], 10) : 0;
  const parsedReset = parseResetText(text, now);
  const resetsAt = parsedReset ?? new Date(now.getTime() + 3 * 86400000).toISOString();
  const periodStart = (parsedReset ? new Date(new Date(resetsAt).getTime() - 7 * 86400000) : new Date(now.getTime() - 7 * 86400000)).toISOString();
  return {
    provider,
    plan: "unknown",
    usedPct,
    resetsAt,
    periodStart,
    raw: text,
    source: "manual",
    fetchedAt: now.toISOString(),
  };
}

export const manualAdapter = {
  id: "manual",
  requiresAuth: "none",
  async ingest(provider: string, text: string) {
    return parseManualUsage(provider, text);
  },
  async poll(): Promise<Quota> {
    throw new Error("manual has no poll — use ingest");
  },
};
