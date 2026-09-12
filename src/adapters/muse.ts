import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseResetText } from "./parse.js";
import { runPty, stripAnsi } from "./pty.js";
import { adapterSignal } from "../runtime/spawn.js";
import type { ParsedQuota } from "./types.js";

// QuotaCap-owned empty probe dir, beside the config and database. Muse loads
// project-local skills, rules, hooks and plugin config from cwd, so the probe
// never runs in $HOME or a user project — an empty dir grants nothing.
export function museProbeDir(): string {
  return path.join(process.env.QUOTACAP_HOME ?? os.homedir(), ".quotacap", "muse-probe");
}

export function parseMuseTui(text: string, now = new Date()): ParsedQuota {
  // After ANSI stripping the panel is ONE line (cursor-addressed, no
  // newlines), so no pattern here may anchor on ^, $ or \n.
  const cleaned = stripAnsi(text);
  const weekly = cleaned.match(/Weekly\s+(\d+)%\s+used/i);
  if (!weekly) throw new Error("muse: weekly usage not found in TUI output");
  const current = cleaned.match(/Current\s+(\d+)%\s+used/i);
  if (!current) throw new Error("muse: current-window usage not found in TUI output");
  const usedPct = parseInt(weekly[1], 10);
  const sessionPct = parseInt(current[1], 10);
  if (!Number.isFinite(usedPct) || usedPct < 0 || usedPct > 100)
    throw new Error("muse: bad weekly pct");
  if (!Number.isFinite(sessionPct) || sessionPct < 0 || sessionPct > 100)
    throw new Error("muse: bad current pct");

  // First match wins; overdrawn transcripts carry two identical copies.
  // Vendor casing preserved (grok precedent: SuperGrok); the Muse Code
  // product prefix is stripped because the product is already the row label.
  let plan = "unknown";
  const planMatch = cleaned.match(/Subscription\s*·\s*Muse Code\s+(.+?)\s{2,}/i);
  if (planMatch) plan = planMatch[1].trim();

  // The Current-window reset ("Resets at 3:51 PM") is a bare clock time with
  // no date, and Quota has no session-reset field — discarded, as claude and
  // kimi already do. A missing or unparseable Weekly reset throws rather than
  // estimating: an invented reset would feed the advisory a false deadline.
  const resetMatch = cleaned.match(
    /Weekly[^\n]*?Resets\s+([A-Za-z]{3}\s+\d{1,2}\s+at\s+\d{1,2}:\d{2}\s*[AP]M)/i,
  );
  if (!resetMatch) throw new Error("muse: bad weekly reset");
  const resetRaw = resetMatch[1].trim();
  const resetsAt = parseResetText(`resets ${resetRaw}`, now);
  if (!resetsAt) throw new Error(`muse: bad weekly reset "${resetRaw}"`);

  const periodStart = new Date(new Date(resetsAt).getTime() - 7 * 86400000).toISOString();
  return {
    provider: "muse",
    plan,
    usedPct,
    sessionPct,
    resetsAt,
    periodStart,
    source: "tui",
    fetchedAt: now.toISOString(),
    raw: cleaned.slice(0, 4096),
  };
}

export const museAdapter = {
  id: "muse",
  requiresAuth: "muse login (CLI owns credentials)",
  async poll(): Promise<ParsedQuota> {
    const cwd = museProbeDir();
    fs.mkdirSync(cwd, { recursive: true });
    const transcript = await runPty({
      file: "muse",
      args: ["--trust-workspace"],
      cwd,
      // Without this, a missing binary triggers a foreground 248 MB download
      // on every poll; with it the launcher dies fast with a clear message.
      env: { MUSE_NO_AUTO_UPDATE: "1" },
      cols: 140,
      rows: 50,
      readyRegex: /muse-spark|Muse Code \d/,
      readyTimeoutMs: 8000,
      settleDelayMs: 1000,
      // Two-phase submit: "/usage" first, CR 1500ms later. A single combined
      // write is swallowed by the slash-command autocomplete and never runs.
      input: "/usage",
      submitInput: "\r",
      submitAfterMs: 1500,
      completionRegex: /Subscription/i,
      // Trust prompt (in case a future Muse ignores the flag), an accidental
      // model turn from a mistimed Enter, and the unavailable-subscription
      // fast-fail — every one aborts to a degraded row, never a 14s timeout.
      abortOn:
        /Do you trust this workspace|Working \(\d+s|Subscriptions aren't currently available|subscription_unavailable/,
      timeoutMs: 14000,
      respondToQueries: true,
      maxBytes: 256 * 1024,
      signal: adapterSignal("muse"),
      label: "muse",
    });
    return parseMuseTui(transcript);
  },
};
