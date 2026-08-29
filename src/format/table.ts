// The one table every surface renders: MCP tools, CLI status, web dashboard.
// Quotas carry used/resets; advisories add days-left, burn and waste analysis.
// Without advisories the analysis columns render as placeholders.

export function formatResetDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function renderQuotasTable(quotas: any[], advisories: any[] = []): string {
  const rows = quotas.map((q) => {
    const a = advisories.find((x) => x.provider === q.provider);
    const used = Math.round(q.usedPct ?? 0);
    const resets = q.resetsAt ? formatResetDate(q.resetsAt) : "—";
    const daysLeft = a?.daysLeft != null ? a.daysLeft.toFixed(1) : "—";
    const ideal = a?.idealRate != null ? `${Math.round(a.idealRate)}%/day` : "—";
const burn = (() => {
      if (a?.burnMeasured) return `${a.burnRate.toFixed(1)}%/day`;
      if (q.periodStart) {
        const elapsed = (Date.now() - new Date(q.periodStart).getTime()) / 86400000;
        if (elapsed > 0.1) return `${((q.usedPct ?? 0) / elapsed).toFixed(1)}%/day avg`;
      }
      return "—";
    })();
    // Renderers that count emoji as one cell but paint two (Kimi, Claude
    // Code) shift the pipes after a wide glyph by +1; the status glyphs
    // live in the last column so the shift touches only the right border.
    const icon = a?.status === "at risk" ? "⚠️" : a != null ? "✅" : "—";
    const waste = a?.wastePct != null ? `${Math.round(a.wastePct)}%` : "—";
    return `| ${q.provider} | ${used}% | ${100 - used}% | ${resets} | ${daysLeft} | ${ideal} | ${burn} | ${waste} | ${icon} |`;
  });
  return [
    "| Provider | Used | Remaining | Resets | Days left | Ideal daily burn | Burn rate | Waste if unused | Status |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}