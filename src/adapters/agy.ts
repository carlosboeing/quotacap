import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Adapter, ParsedQuota } from "./types.js";
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

function parseGroup(
  g: AgyGroup,
  provider: string,
  rawJsonString: string,
  now: Date
): ParsedQuota | null {
  if (!Array.isArray(g.buckets)) return null;
  const weekly = g.buckets.find((b) => b.window === "weekly");
  if (!weekly) return null;
  const usedPct = usedPctFromRemaining(weekly.remaining_fraction);
  if (usedPct === null) return null;
  const rawReset = weekly.reset_time;
  const resetDate = rawReset ? new Date(rawReset) : null;
  if (!resetDate || Number.isNaN(resetDate.getTime())) throw new Error("agy: bad weekly reset_time");
  const resetsAt = resetDate.toISOString();
  const periodStart = new Date(resetDate.getTime() - 7 * 86400000).toISOString();

  const fiveHour = g.buckets.find((b) => b.window === "5h");
  const sessionPct = fiveHour
    ? usedPctFromRemaining(fiveHour.remaining_fraction) ?? undefined
    : undefined;

  return {
    provider,
    plan: "unknown",
    usedPct,
    sessionPct,
    resetsAt,
    periodStart,
    source: "cli",
    fetchedAt: now.toISOString(),
    raw: rawJsonString,
  };
}

export function parseAgyUsage(parsedJson: any, now = new Date()): ParsedQuota[] {
  if (parsedJson?.status !== "SUCCESS") throw new Error("agy: status is not SUCCESS");
  const groups: AgyGroup[] = parsedJson?.command?.data?.groups;
  if (!Array.isArray(groups)) throw new Error("agy: no usage groups");

  const raw = JSON.stringify(parsedJson);
  const rows: ParsedQuota[] = [];

  const geminiGroup = groups.find(
    (g) => /gemini/i.test(g.name ?? "") || g.buckets?.some((b) => b.id?.startsWith("gemini"))
  );
  if (geminiGroup) {
    const q = parseGroup(geminiGroup, "agy", raw, now);
    if (q) rows.push(q);
  }

  const threePGroup = groups.find(
    (g) => /claude|gpt|3p/i.test(g.name ?? "") || g.buckets?.some((b) => b.id?.startsWith("3p"))
  );
  if (threePGroup) {
    const q = parseGroup(threePGroup, "agy:3p", raw, now);
    if (q) rows.push(q);
  }

  if (rows.length === 0) {
    for (const g of groups) {
      const q = parseGroup(g, "agy", raw, now);
      if (q) {
        rows.push(q);
        break;
      }
    }
  }

  if (rows.length === 0) throw new Error("agy: no weekly bucket");
  return rows;
}

export const agyAdapter: Adapter = {
  id: "agy",
  requiresAuth: "agy login (CLI owns credentials)",
  async poll(): Promise<ParsedQuota[]> {
    const { stdout } = await exec("agy", ["-p", "/usage", "--output-format", "json"], { timeout: 20000 });
    return parseAgyUsage(JSON.parse(stdout));
  },
};
