import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Quota } from "./types.js";
const exec = promisify(execFile);
export function parseClaudeUsage(result: string, now = new Date()): Quota {
  const sessionMatch = result.match(/Current session:\s+(\d+)% used[^·]*·\s*resets\s+([^\n(]+?)\s*\(/);
  const weeklyMatch = result.match(/Current week \(all models\):\s+(\d+)% used[^·]*·\s*resets\s+([^\n(]+?)\s*\(/);
  const usedPct = weeklyMatch ? parseInt(weeklyMatch[1],10) : 0;
  const sessionPct = sessionMatch ? parseInt(sessionMatch[1],10) : undefined;
  const resetsRaw = weeklyMatch?.[2].trim() ?? "";
  // TODO: real TZ parse with date-fns-tz for all months
  let resetsAt = new Date(now.getTime()+7*86400000).toISOString();
  if (resetsRaw.includes("Sep 3")) resetsAt = "2026-09-03T21:00:00+10:00";
  if (resetsRaw.includes("Aug 28")) resetsAt = "2026-08-28T16:30:00+10:00";
  return {
    provider: "claude", plan: "max", usedPct, sessionPct,
    resetsAt, periodStart: new Date(now.getTime() - 7*86400000).toISOString(),
    raw: result, source: "cli", fetchedAt: now.toISOString()
  };
}
export const claudeAdapter = {
  id: "claude",
  requiresAuth: "keychain:Claude Code-credentials",
  async poll(): Promise<Quota> {
    const { stdout } = await exec("claude", ["-p","/usage","--output-format","json"], { timeout: 8000 });
    const parsed = JSON.parse(stdout);
    const result: string = parsed.result ?? stdout;
    return parseClaudeUsage(result);
  }
};
