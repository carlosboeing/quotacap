import React from "react";
import type { ProviderView } from "../state.js";
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
  const name = provider.displayName;
  return (
    <div
      data-testid={`provider-row-${provider.id}`}
      className={`lrow ${recommended ? "is-recommended is-top-pick" : ""}`}
      onClick={() => onSelect(provider.id)}
    >
      <div className="prov" data-label="Provider">
        <span
          className="dot"
          style={{ background: `var(--p-${provider.id.split(":")[0]}, var(--surface-raised))` }}
          aria-hidden="true"
        />
        <span>
          <span className="nm">
            {name}
            {recommended && (
              <span className="rec-icon" title="Recommended for next session" role="img" aria-label="recommended">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" />
                </svg>
              </span>
            )}
          </span>
          {quota?.plan && <span className="pl">{quota.plan}</span>}
          {quota?.sessionPct !== undefined && quota.sessionPct !== null && (
            <span className="src">Session use {quota.sessionPct}%</span>
          )}
        </span>
      </div>
      <div data-label="Used vs elapsed">
        {quota ? <PaceBar provider={provider} asOf={asOf} /> : "—"}
      </div>
      <div data-label="Resets in">
        <span className="cell-b">{resetCountdown(provider, asOfMs)}</span>
      </div>
      <div data-label="Pace">
        <Badge provider={provider} />
        {advisory && advisory.burnRate !== null && (
          <div className="cell-s" style={{ marginTop: 2 }}>
            Pace {advisory.burnRate.toFixed(1)}%/d · needed {advisory.idealRate.toFixed(1)}%/d
          </div>
        )}
        {evidence.length > 0 && <div className="cell-s" style={{ marginTop: 2 }}>{evidence.join(" · ")}</div>}
      </div>
      <button
        type="button"
        className="rowbtn"
        onClick={(e) => {
          e.stopPropagation();
          onSelect(provider.id);
        }}
      >
        Inspect
      </button>
      <span className="sr-only">{forecastLine(provider)}</span>
    </div>
  );
}
