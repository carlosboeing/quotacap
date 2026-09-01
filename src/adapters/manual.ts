import { parseResetText } from "./parse.js";
import type { ParsedQuota } from "./types.js";

export function parseManualUsage(provider: string, text: string, now = new Date()): ParsedQuota {
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
    source: "manual",
    fetchedAt: now.toISOString(),
    raw: text,
  };
}

export const manualAdapter = {
  id: "manual",
  requiresAuth: "none",
  async ingest(provider: string, text: string): Promise<ParsedQuota> {
    return parseManualUsage(provider, text);
  },
  async poll(): Promise<ParsedQuota> {
    throw new Error("manual has no poll — use ingest");
  },
};
