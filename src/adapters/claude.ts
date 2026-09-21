import { trackedExecFile } from "../runtime/spawn.js";
import { parseResetText } from "./parse.js";
import type { ParsedQuota } from "./types.js";

export function parseClaudeUsage(result: string, now = new Date()): ParsedQuota {
  const sessionMatch = result.match(/Current session:\s+(\d+)%\s+used/i);
  const weeklyMatch =
    result.match(/Current week \(all models\):\s+(\d+)%\s+used/i) ??
    result.match(/Current week[^\d%]*(\d+)%\s+used/i);
  const usedPct = weeklyMatch ? parseInt(weeklyMatch[1], 10) : 0;
  const sessionPct = sessionMatch ? parseInt(sessionMatch[1], 10) : undefined;
  let resetsAt = parseResetText(result, now);
  const parsedReset = !!resetsAt;
  if (!resetsAt) resetsAt = new Date(now.getTime()+7*86400000).toISOString();
  const resets = new Date(resetsAt).getTime();
  const periodStart = (parsedReset ? new Date(resets - 7*86400000) : new Date(now.getTime() - 7*86400000)).toISOString();
  return {
    provider: "claude", plan: "max", weeklyPct: usedPct, fiveHourPct: sessionPct,
    resetsAt, periodStart, source: "cli", fetchedAt: now.toISOString(), raw: result,
  };
}
export interface ClaudeAdapter {
  id: string;
  requiresAuth: string;
  execPath: string;
  poll(execPath?: string): Promise<ParsedQuota>;
}

export const claudeAdapter: ClaudeAdapter = {
  id: "claude",
  requiresAuth: "keychain:Claude Code-credentials",
  execPath: "claude",
  async poll(execPath?: string): Promise<ParsedQuota> {
    const bin = execPath ?? claudeAdapter.execPath ?? "claude";
    // --strict-mcp-config: a usage read needs no MCP servers. Without it every
    // poll boots the user's servers under the daemon's PATH, and their failures
    // are cached and hide those servers from the user's own sessions.
    const { stdout } = await trackedExecFile("claude", bin, ["-p","/usage","--output-format","json","--strict-mcp-config"], { timeout: 8000 });
    const parsed = JSON.parse(stdout);
    const result: string = parsed.result ?? stdout;
    return parseClaudeUsage(result);
  }
};
