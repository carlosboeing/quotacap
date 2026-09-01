import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Quota } from "./types.js";
const exec = promisify(execFile);

interface AgyBucket {
  id?: string;
  window?: string;
  remaining_fraction?: number;
  reset_time?: string;
}
interface AgyGroup {
  name?: string;
  buckets?: AgyBucket[];
}

function usedPctFromRemaining(remaining: unknown): number | null {
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return null;
  const pct = Math.round((1 - remaining) * 100);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  return pct;
}

function weeklyBuckets(groups: AgyGroup[]): { group: string; bucket: AgyBucket; usedPct: number }[] {
  const out: { group: string; bucket: AgyBucket; usedPct: number }[] = [];
  for (const g of groups) {
    if (!Array.isArray(g.buckets)) continue;
    for (const bucket of g.buckets) {
      if (bucket.window !== "weekly") continue;
      const usedPct = usedPctFromRemaining(bucket.remaining_fraction);
      if (usedPct === null) continue;
      out.push({ group: String(g.name ?? ""), bucket, usedPct });
    }
  }
  return out;
}

export function parseAgyUsage(parsedJson: any, now = new Date()): Quota {
  if (parsedJson?.status !== "SUCCESS") throw new Error("agy: status is not SUCCESS");
  const groups = parsedJson?.command?.data?.groups;
  if (!Array.isArray(groups)) throw new Error("agy: no usage groups");
  const weekly = weeklyBuckets(groups);
  if (weekly.length === 0) throw new Error("agy: no weekly bucket");
  const geminiWeekly = weekly.find((w) => w.group === "Gemini Models");
  const chosen = geminiWeekly ?? weekly.reduce((best, w) => (w.usedPct > best.usedPct ? w : best));
  const rawReset = chosen.bucket.reset_time;
  const resetDate = rawReset ? new Date(rawReset) : null;
  if (!resetDate || Number.isNaN(resetDate.getTime())) throw new Error("agy: bad weekly reset_time");
  const resetsAt = resetDate.toISOString();
  const periodStart = new Date(resetDate.getTime() - 7 * 86400000).toISOString();
  const gemini5h = groups
    .filter((g: AgyGroup) => g.name === "Gemini Models")
    .flatMap((g: AgyGroup) => g.buckets ?? [])
    .find((b: AgyBucket) => b.window === "5h");
  const sessionPct = gemini5h ? usedPctFromRemaining(gemini5h.remaining_fraction) ?? undefined : undefined;
  return {
    provider: "agy",
    plan: "unknown",
    usedPct: chosen.usedPct,
    sessionPct,
    resetsAt,
    periodStart,
    raw: JSON.stringify(parsedJson),
    source: "cli",
    fetchedAt: now.toISOString(),
  };
}

export const agyAdapter = {
  id: "agy",
  requiresAuth: "agy login (CLI owns credentials)",
  async poll(): Promise<Quota> {
    const { stdout } = await exec("agy", ["-p", "/usage", "--output-format", "json"], { timeout: 20000 });
    return parseAgyUsage(JSON.parse(stdout));
  },
};
