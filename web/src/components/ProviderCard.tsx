import React from "react";
import type { ProviderView } from "../state.js";
import { ageDuration } from "../state.js";
import {
  Badge,
  PaceBar,
  isEstimated,
  resetClock,
  resetCountdown,
  timeLeft,
} from "./PaceBar.js";
import { ProviderIcon, providerTint } from "./ProviderIcon.js";

function resetsDate(provider: ProviderView): string | null {
  if (!provider.quota) return null;
  const clock = resetClock(provider.quota.resetsAt);
  if (!clock) return null;
  return `Resets ${clock}${isEstimated(provider) ? " (est.)" : ""}`;
}

export function ProviderCard({
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
  const updated = ageDuration(provider.ageMs);
  const resetsIn = quota ? timeLeft(quota.resetsAt, asOfMs) : null;
  const name = provider.displayName;
  return (
    <article
      data-testid={`provider-card-${provider.id}`}
      role="button"
      tabIndex={0}
      aria-label={`${name} details`}
      onClick={() => onSelect(provider.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(provider.id);
        }
      }}
      className={`pcard ${recommended ? "is-recommended is-top-pick" : ""}`}
    >
      <div className="pcard-head">
        <span className="picon" style={providerTint(provider.id)} aria-hidden="true">
          <ProviderIcon id={provider.id} title={name} />
        </span>
        <div className="who">
          <b>
            {name}
            {recommended && (
              <span className="rec-icon" title="Recommended for next session" role="img" aria-label="recommended">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" />
                </svg>
              </span>
            )}
          </b>
          {quota && quota.plan && <span className="pl">{quota.plan}</span>}
          {updated && <span className="src">Updated {updated} ago</span>}
        </div>
        <Badge provider={provider} />
      </div>

      <div className="pcard-body">
        <PaceBar provider={provider} asOf={asOf} />

        <div className="pstats">
          <div>
            <span className="l">Pace</span>
            <span className="v">
              {advisory && advisory.burnRate !== null ? `${advisory.burnRate.toFixed(1)}%/d` : "—"}
            </span>
          </div>
          <div>
            <span className="l">Needed</span>
            <span className="v">
              {advisory ? `${advisory.idealRate.toFixed(1)}%/d` : "—"}
            </span>
          </div>
          <div>
            <span className="l">Resets in</span>
            <span className="v">
              {resetsIn ? `${resetsIn}${isEstimated(provider) ? " (est.)" : ""}` : resetCountdown(provider, asOfMs)}
            </span>
          </div>
        </div>
      </div>

      <div className="pcard-foot">
        <span>{resetsDate(provider) ?? resetCountdown(provider, asOfMs)}</span>
        <span className="rowbtn" aria-hidden="true">Inspect</span>
      </div>
    </article>
  );
}
