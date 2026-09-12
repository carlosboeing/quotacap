// MCP markdown table reusing the row model: the same words and numbers as
// the terminal renderers, in GitHub-flavored markdown.
import type { StateSnapshot } from "../advisory/types.js";
import { buildRow, sortProviders } from "./rows.js";

function esc(cell: string): string {
  return cell.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

export function renderMarkdownTable(snapshot: StateSnapshot, now: Date): string {
  const use = snapshot.recommendation.use;
  const sorted = sortProviders(snapshot.providers, "recommended", use);
  const lines = sorted.map((p) => {
    const row = buildRow(p, now);
    const name = p.id === use && use !== "none" ? `★ ${p.displayName}` : p.displayName;
    const used = row.usedPct === null ? "—" : `${row.usedPct}%`;
    const elapsed = row.elapsedPct === null ? "—" : `${row.elapsedPct}%`;
    return `| ${esc(name)} | ${used} | ${elapsed} | ${esc(row.countdown)} | ${esc(row.state)} | ${esc(row.forecast)} |`;
  });
  return [
    "| Provider | Used | Elapsed | Resets | State | Forecast |",
    "|---|---|---|---|---|---|",
    ...lines,
  ].join("\n");
}

export function renderRecommendationSummary(snapshot: StateSnapshot): string {
  const rec = snapshot.recommendation;
  return `${rec.use}: ${rec.reason}`;
}
