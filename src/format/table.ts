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
      if (!a || a.burnRate == null || a.paceSource === "unknown" || a.status === "unknown") {
        return "—";
      }
      const isRecent = a.paceSource === "recent" || (a.paceSource == null && a.burnMeasured);
      const rate = isRecent
        ? `${a.burnRate.toFixed(1)}%/day`
        : q.periodStart ? (() => {
            const elapsed = (Date.now() - new Date(q.periodStart).getTime()) / 86400000;
            if (elapsed > 0.1) return `${((q.usedPct ?? 0) / elapsed).toFixed(1)}%/day avg`;
            return null;
          })()
        : null;
      if (!rate) return "—";
      // Verdict against the ideal rate: outside the +-20% band the cell says
      // (fast)/(slow); inside it a single-width check mark.
      const value = isRecent ? a.burnRate : q.periodStart ? (q.usedPct ?? 0) / Math.max(0.1, (Date.now() - new Date(q.periodStart).getTime()) / 86400000) : null;
      const ideal = a?.idealRate;
      if (ideal != null && value != null) {
        if (value > ideal * 1.2) return `${rate} (fast)`;
        if (value < ideal * 0.8) return `${rate} (slow)`;
        return `${rate} ✔`;
      }
      return rate;
    })();
    // Renderers that count emoji as one cell but paint two (Kimi, Claude
    // Code) shift the pipes after a wide glyph by +1; the status glyphs
    // live in the last column so the shift touches only the right border.
    const icon = a?.status === "at risk" ? "⚠️" : a != null ? "✅" : "—";
    const waste = a?.wastePct != null ? `${Math.round(a.wastePct)}%` : "—";
    return `| ${q.provider} | ${used}% | ${100 - used}% | ${resets} | ${daysLeft} | ${ideal} | ${burn} | ${waste} |`;
  });
  return [
    "| Provider | Used | Left | Resets | Days left | Ideal daily burn | Burn rate | Waste if unused |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}