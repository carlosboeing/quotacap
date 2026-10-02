import { trackedExecFile } from "../runtime/spawn.js";
import { attachEvidence } from "../diagnostics/failure.js";
import { parseResetText } from "./parse.js";
import type { ParsedQuota } from "./types.js";

export function parseClaudeUsage(result: string, now = new Date()): ParsedQuota {
  const sessionMatch = result.match(/Current session:\s+(\d+)%\s+used/i);
  const weeklyMatch =
    result.match(/Current week \(all models\):\s+(\d+)%\s+used/i) ??
    result.match(/Current week[^\d%]*(\d+)%\s+used/i);
  const usedPct = weeklyMatch ? parseInt(weeklyMatch[1], 10) : 0;
  const sessionPct = sessionMatch ? parseInt(sessionMatch[1], 10) : undefined;
  // The paced window's reset lives on the "Current week" line. Parse that
  // line alone: within ~5h of the weekly roll the session reset is sooner,
  // and whole-text farthest-wins would pick it instead (muse precedent:
  // scope to the weekly section, then degrade to +7d when it won't parse).
  const weeklyLine = result.match(/^.*current week.*$/gim)?.[0];
  let resetsAt = parseResetText(weeklyLine ?? result, now);
  const parsedReset = !!resetsAt;
  if (!resetsAt) resetsAt = new Date(now.getTime()+7*86400000).toISOString();
  const resets = new Date(resetsAt).getTime();
  const periodStart = (parsedReset ? new Date(resets - 7*86400000) : new Date(now.getTime() - 7*86400000)).toISOString();
  return {
    provider: "claude", plan: "unknown", weeklyPct: usedPct, fiveHourPct: sessionPct,
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
    // 15s matches the registry gate (ADAPTER_TIMEOUTS): cold starts measured
    // 2-4.4s wall, and seven concurrent polls contend for the same CPU.
    const { stdout } = await trackedExecFile("claude", bin, ["-p","/usage","--output-format","json","--strict-mcp-config"], { timeout: 15000 });
    try {
      const parsed = JSON.parse(stdout);
      const result: string = parsed.result ?? stdout;
      return parseClaudeUsage(result);
    } catch (e) {
      // Side-channel only: the output a parse throw would discard, for
      // failure bundles. The message is untouched.
      attachEvidence(e, { source: "exec", stdout });
      throw e;
    }
  }
};
