import React from "react";
import type { ProviderView } from "../state.js";
import { displayName } from "../names.js";
import {
  Badge,
  PaceBar,
  evidenceLabels,
  forecastLine,
  resetCountdown,
} from "./PaceBar.js";

export function ProviderRow({
  provider,
  recommended,
  asOf,
  onSelect,
}: {
  provider: ProviderView;
  recommended: boolean;
  asOf: string;
  onSelect: (id: string) => void;
}) {
  const quota = provider.quota;
  const advisory = provider.advisory;
  const asOfMs = Date.parse(asOf);
  const evidence = evidenceLabels(provider.evidence);
  return (
    <tr data-testid={`provider-row-${provider.id}`} onClick={() => onSelect(provider.id)}>
      <td>
        <button type="button" onClick={() => onSelect(provider.id)}>
          {recommended ? "★ " : ""}
          {displayName(provider.id)}
        </button>
        {quota?.sessionPct !== undefined && quota.sessionPct !== null && (
          <div style={{ font: "var(--t-1)" }}>Session use {quota.sessionPct}%</div>
        )}
      </td>
      <td>
        {quota ? (
          <>
            <div>{quota.usedPct}%</div>
            <PaceBar provider={provider} asOf={asOf} />
          </>
        ) : (
          "—"
        )}
      </td>
      <td>{resetCountdown(provider, asOfMs)}</td>
      <td>
        <Badge provider={provider} />
      </td>
      <td>
        <div>
          {advisory && advisory.burnRate !== null
            ? `${advisory.burnRate.toFixed(1)}%/d of ${advisory.idealRate.toFixed(1)}%/d · `
            : ""}
          {forecastLine(provider)}
        </div>
        {evidence.length > 0 && <div style={{ font: "var(--t-1)" }}>{evidence.join(" · ")}</div>}
      </td>
    </tr>
  );
}
