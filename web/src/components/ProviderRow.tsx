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
  const name = displayName(provider.id);
  return (
    <tr
      data-testid={`provider-row-${provider.id}`}
      onClick={() => onSelect(provider.id)}
      className={`lrow ${recommended ? "is-recommended" : ""}`}
      style={{ cursor: "pointer" }}
    >
      <td>
        <div className="prov">
          <span
            className="dot"
            style={{ background: `var(--p-${provider.id}, var(--surface-raised))` }}
            aria-hidden="true"
          />
          <div>
            <button
              type="button"
              className="rnm"
              style={{ fontWeight: 600 }}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(provider.id);
              }}
            >
              {recommended ? "★ " : ""}
              {name}
            </button>
            {quota?.sessionPct !== undefined && quota.sessionPct !== null && (
              <div className="cell-s">Session use {quota.sessionPct}%</div>
            )}
          </div>
        </div>
      </td>
      <td>
        {quota ? (
          <div>
            <div className="cell-b">{quota.usedPct}%</div>
            <PaceBar provider={provider} asOf={asOf} />
          </div>
        ) : (
          "—"
        )}
      </td>
      <td className="cell-b">{resetCountdown(provider, asOfMs)}</td>
      <td>
        <Badge provider={provider} />
      </td>
      <td>
        <div className="cell-s" style={{ fontWeight: 500, color: "var(--ink)" }}>
          {advisory && advisory.burnRate !== null
            ? `${advisory.burnRate.toFixed(1)}%/d of ${advisory.idealRate.toFixed(1)}%/d · `
            : ""}
          {forecastLine(provider)}
        </div>
        {evidence.length > 0 && <div className="cell-s" style={{ marginTop: 2 }}>{evidence.join(" · ")}</div>}
      </td>
    </tr>
  );
}
