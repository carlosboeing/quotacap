import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseResetText } from "./parse.js";
import type { Quota } from "./types.js";
const exec = promisify(execFile);

export function parseClaudeUsage(result: string, now = new Date()): Quota {
  const sessionMatch = result.match(/Current session:\s+(\d+)% used[^·]*·\s*resets\s+([^\n(]+?)\s*\(/);
  const weeklyMatch = result.match(/Current week \(all models\):\s+(\d+)% used[^·]*·\s*resets\s+([^\n(]+?)\s*\(/);
  const usedPct = weeklyMatch ? parseInt(weeklyMatch[1],10) : 0;
  const sessionPct = sessionMatch ? parseInt(sessionMatch[1],10) : undefined;
  let resetsAt = parseResetText(result, now);
  const parsedReset = !!resetsAt;
  if (!resetsAt) resetsAt = new Date(now.getTime()+7*86400000).toISOString();
  const resets = new Date(resetsAt).getTime();
  const periodStart = (parsedReset ? new Date(resets - 7*86400000) : new Date(now.getTime() - 7*86400000)).toISOString();
  return {
    provider: "claude", plan: "max", usedPct, sessionPct,
    resetsAt, periodStart, raw: result, source: "cli", fetchedAt: now.toISOString()
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
