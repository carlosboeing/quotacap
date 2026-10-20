import React from "react";
import type { ProviderView } from "../state.js";
import { ageDuration } from "../state.js";
import {
  Badge,
  PaceBar,
  PaceStats,
  isMonthlyBound,
  quotaResetEstimated,
  quotaResetsAt,
  resetClock,
  resetCountdown,
  resetDateClock,
} from "./PaceBar.js";
import { ProviderIcon, providerTint } from "./ProviderIcon.js";
import { lastClose } from "./ClosedWeeks.js";
import { WindowsRow } from "./WindowsRow.js";

function resetsDate(provider: ProviderView): string | null {
  const resetIso = quotaResetsAt(provider);
  if (!resetIso) return null;
  const clock = isMonthlyBound(provider) ? resetDateClock(resetIso) : resetClock(resetIso);
  if (!clock) return null;
  return `Resets ${clock}${quotaResetEstimated(provider) ? " (est.)" : ""}`;
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
  const asOfMs = Date.parse(asOf);
  const updated = ageDuration(provider.ageMs);
  const name = provider.displayName;
  const last = lastClose(provider);
  return (
    <article
      data-testid={`provider-card-${provider.id}`}
      role="button"
      tabIndex={0}
      aria-label={`${name} details`}
      onClick={() => onSelect(provider.id)}
      onKeyDown={(e) => {
        // Space or Enter aimed at the windows chevron must not also open the drawer.
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
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
          {updated && <span className="src">Updated {updated} ago</span>}
        </div>
        <Badge provider={provider} />
      </div>

      <div className="pcard-body">
        <PaceBar provider={provider} asOf={asOf} />
        <WindowsRow provider={provider} asOf={asOf} variant="card" />

        <PaceStats provider={provider} asOf={asOf} />
      </div>

      <div className="pcard-foot">
        <div className="foot-meta">
          <span>{resetsDate(provider) ?? resetCountdown(provider, asOfMs)}</span>
          {last && (
            <span className="last-week">
              Last {isMonthlyBound(provider) ? "month" : "week"} {last.leftoverPct}% leftover{last.resetsAtEstimated ? " (est.)" : ""}
            </span>
          )}
        </div>
        <span className="rowbtn" aria-hidden="true">Inspect</span>
      </div>
    </article>
  );
}
