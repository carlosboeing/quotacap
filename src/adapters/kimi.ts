import os from "node:os";
import { parseResetText } from "./parse.js";
import { runPty, stripAnsi } from "./pty.js";
import type { ParsedQuota } from "./types.js";

export function parseKimiTui(text: string, now = new Date()): ParsedQuota {
  const cleaned = stripAnsi(text);
  const weeklyRe = /Weekly limit\s+[^0-9]*(\d+)%\s+used\s+resets\s+(in\s+[^\n│\r]+)/i;
  const fiveRe = /5h limit\s+[^0-9]*(\d+)%\s+used\s+resets\s+(in\s+[^\n│\r]+)/i;
  const w = cleaned.match(weeklyRe);
  if (!w) throw new Error("kimi: weekly limit not found in TUI output");
  const f = cleaned.match(fiveRe);
  if (!f) throw new Error("kimi: 5h limit not found in TUI output");
  const usedPct = parseInt(w[1], 10);
  const sessionPct = parseInt(f[1], 10);
  if (!Number.isFinite(usedPct) || usedPct < 0 || usedPct > 100)
    throw new Error("kimi: bad weekly pct");
  if (!Number.isFinite(sessionPct) || sessionPct < 0 || sessionPct > 100)
    throw new Error("kimi: bad 5h pct");
  const weeklyRaw = w[2].trim();
  const fiveRaw = f[2].trim();
  const weeklyIso = parseResetText(`resets ${weeklyRaw}`, now);
  if (!weeklyIso) throw new Error(`kimi: bad weekly reset "${weeklyRaw}"`);
  const fiveIso = parseResetText(`resets ${fiveRaw}`, now);
  if (!fiveIso) throw new Error(`kimi: bad 5h reset "${fiveRaw}"`);

  let plan = "unknown";
  const paren = cleaned.match(/Weekly limit\s*\(([^)]+)\)/i);
  if (paren) {
    plan = paren[1].trim().toLowerCase();
  } else {
    const lvl = cleaned.match(/level\s*[:\-]\s*([A-Za-z0-9_\-]+)/i);
    if (lvl) plan = lvl[1].trim().toLowerCase().replace(/^level_/i, "");
  }

  const periodStart = new Date(new Date(weeklyIso).getTime() - 7 * 86400000).toISOString();
  return {
    provider: "kimi",
    plan,
    usedPct,
    sessionPct,
    resetsAt: weeklyIso,
    periodStart,
    source: "tui",
    fetchedAt: now.toISOString(),
    raw: cleaned.slice(0, 4096),
  };
}

export const kimiAdapter = {
  id: "kimi",
  requiresAuth: "kimi login (CLI owns credentials)",
  async poll(): Promise<ParsedQuota> {
    // Use homedir as neutral cwd so quota modal does not depend on project path
    // and workspace-trust prompts are minimized. Fail closed if trust prompt appears.
    const transcript = await runPty({
      file: "kimi",
      args: [],
      cols: 140,
      rows: 35,
      cwd: os.homedir(),
      readyRegex: /Welcome to Kimi Code|context:/i,
      readyTimeoutMs: 8000,
      input: "/usage\r",
      completionRegex: /Weekly limit[\s\S]*?5h limit|5h limit[\s\S]*?Weekly limit/i,
      abortOn: /Trust this folder\?/i,
      timeoutMs: 8000,
      maxBytes: 256 * 1024,
    });
    return parseKimiTui(transcript);
  },
};
