// MCP markdown table reusing the row model: the same words and numbers as
// the terminal renderers, in GitHub-flavored markdown.
import type { StateSnapshot } from "../advisory/types.js";
import { rateLimitWaitLines } from "./rate-limit-wait.js";
import { buildRow, shownProviders, sortProviders, useName } from "./rows.js";

function esc(cell: string): string {
  return cell.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

export function renderMarkdownTable(snapshot: StateSnapshot, now: Date): string {
  const use = snapshot.recommendation.use;
  const sorted = sortProviders(shownProviders(snapshot.providers), "recommended", use);
  const lines = sorted.map((p) => {
    const row = buildRow(p, now);
    const name = p.id === use && use !== "none" ? `★ ${p.displayName}` : p.displayName;
    const used = row.usedPct === null ? "—" : `${row.usedPct}%`;
    const elapsed = row.elapsedPct === null ? "—" : `${row.elapsedPct}%`;
    const wait = row.wait === "" ? "—" : row.wait;
    return `| ${esc(name)} | ${used} | ${elapsed} | ${esc(row.pace)} | ${esc(row.countdown)} | ${esc(row.state)} | ${esc(row.forecast)} | ${esc(wait)} |`;
  });
  return [
    "| Provider | Used | Elapsed | Pace (%/day avg · 24h) | Resets | State | Forecast | Wait |",
    "|---|---|---|---|---|---|---|---|",
    ...lines,
  ].join("\n");
}

export function renderRecommendationSummary(snapshot: StateSnapshot, now = new Date(snapshot.asOf)): string {
  const rec = snapshot.recommendation;
  const waits = rateLimitWaitLines(shownProviders(snapshot.providers), now);
  return [`${useName(snapshot)}: ${rec.reason}`, ...waits].join("\n");
}

export function renderModelsMarkdownTable(models: any[]): string {
  const lines = models.map((m) => {
    const name = m.displayName ?? m.id;
    const leftover = m.leftoverPct != null ? `${m.leftoverPct}%` : "—";
    const status = m.catalog?.status ?? "unfetched";
    const ids = (m.catalog?.listed ?? []).map((x: any) => x.id).join(", ") || "(none)";
    return `| ${esc(name)} | ${leftover} | ${esc(status)} | ${esc(ids)} |`;
  });
  return [
    "| Provider | Leftover | Catalog | Models |",
    "|---|---|---|---|",
    ...lines,
  ].join("\n");
}
