import React from "react";
import type { ProviderView } from "../state.js";
import { ageDuration } from "../state.js";
import { displayName } from "../names.js";
import {
  Badge,
  PaceBar,
  badgeColor,
  evidenceLabels,
  forecastLine,
  isEstimated,
  paceBadge,
  resetCountdown,
  timeLeft,
} from "./PaceBar.js";

function resetsDate(provider: ProviderView): string | null {
  if (!provider.quota) return null;
  const ms = Date.parse(provider.quota.resetsAt);
  if (!Number.isFinite(ms)) return null;
  const when = new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Resets ${when}${isEstimated(provider) ? " (est.)" : ""}`;
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
  const evidence = evidenceLabels(provider.evidence);
  const resetsIn = quota ? timeLeft(quota.resetsAt, asOfMs) : null;
  const name = displayName(provider.id);
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
      className={`pcard ${recommended ? "is-recommended" : ""}`}
    >
      <div className="pcard-head">
        <span
          className="picon"
          style={{
            background: `var(--p-${provider.id}, var(--surface-raised))`,
            color: "#fff",
          }}
          aria-hidden="true"
        >
          {name.charAt(0)}
        </span>
        <div className="who">
          <b>
            {name}
            {recommended && (
              <span className="recommended-badge" role="img" aria-label="recommended">
                <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1" aria-hidden="true">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
                Top Pick
              </span>
            )}
          </b>
          {quota && quota.plan && <span className="pl">{quota.plan}</span>}
          {updated && <span className="pl">Updated {updated} ago</span>}
        </div>
        <Badge provider={provider} />
      </div>

      <div className="pcard-body">
        {quota ? (
          <div className="pcard-topline">
            <span className="used">{quota.usedPct}% used</span>
            <span className="pcard-underline">→ {forecastLine(provider)}</span>
          </div>
        ) : (
          <div className="pcard-topline">
            <span className="pcard-underline">→ {forecastLine(provider)}</span>
          </div>
        )}

        <PaceBar provider={provider} asOf={asOf} />

        <div className="pstats">
          <div>
            <span className="l">PACE</span>
            <span className="v">
              {advisory && advisory.burnRate !== null ? `${advisory.burnRate.toFixed(1)}%/d` : "—"}
            </span>
          </div>
          <div>
            <span className="l">NEEDED</span>
            <span className="v">
              {advisory ? `${advisory.idealRate.toFixed(1)}%/d` : "—"}
            </span>
          </div>
          <div>
            <span className="l">RESETS IN</span>
            <span className="v">
              {resetsIn ? `${resetsIn}${isEstimated(provider) ? " (est.)" : ""}` : resetCountdown(provider, asOfMs)}
            </span>
          </div>
        </div>

        {quota?.sessionPct !== undefined && quota.sessionPct !== null && (
          <div style={{ font: "var(--t-2)", marginTop: 6, color: "var(--ink-soft)" }}>Session use {quota.sessionPct}%</div>
        )}
        {evidence.length > 0 && (
          <div style={{ font: "var(--t-1)", marginTop: 4, color: "var(--ink-soft)" }}>{evidence.join(" · ")}</div>
        )}
      </div>

      <div className="pcard-foot">
        <span>{resetsDate(provider) ?? resetCountdown(provider, asOfMs)}</span>
        <span style={{ fontWeight: 600 }}>Inspect details &rarr;</span>
      </div>
    </article>
  );
}
