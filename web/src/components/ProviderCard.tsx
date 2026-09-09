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
      style={{
        background: "var(--surface)",
        border: recommended ? "2px solid var(--rec)" : "1px solid var(--line)",
        borderRadius: 12,
        padding: 12,
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          aria-hidden="true"
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: badgeColor(paceBadge(provider)),
            flexShrink: 0,
          }}
        />
        <div style={{ flexGrow: 1, minWidth: 0 }}>
          <div style={{ font: "var(--t-4)" }}>
            {name}{" "}
            {recommended && (
              <span role="img" aria-label="recommended">
                ★
              </span>
            )}
          </div>
          {quota && quota.plan && <div style={{ font: "var(--t-2)" }}>{quota.plan}</div>}
          {updated && <div style={{ font: "var(--t-2)" }}>Updated {updated} ago</div>}
        </div>
        <Badge provider={provider} />
      </div>

      {quota ? (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 8 }}>
          <span style={{ font: "var(--t-3)" }}>{quota.usedPct}% used</span>
          <span style={{ font: "var(--t-2)" }}>→ {forecastLine(provider)}</span>
        </div>
      ) : (
        <div style={{ font: "var(--t-2)", marginTop: 8 }}>→ {forecastLine(provider)}</div>
      )}
      <div style={{ marginTop: 4 }}>
        <PaceBar provider={provider} asOf={asOf} />
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
        <div>
          <div style={{ font: "var(--t-1)" }}>PACE</div>
          <div style={{ font: "var(--t-3)" }}>
            {advisory && advisory.burnRate !== null ? `${advisory.burnRate.toFixed(1)}%/d` : "—"}
          </div>
        </div>
        <div>
          <div style={{ font: "var(--t-1)" }}>NEEDED</div>
          <div style={{ font: "var(--t-3)" }}>
            {advisory ? `${advisory.idealRate.toFixed(1)}%/d` : "—"}
          </div>
        </div>
        <div>
          <div style={{ font: "var(--t-1)" }}>RESETS IN</div>
          <div style={{ font: "var(--t-3)" }}>
            {resetsIn ? `${resetsIn}${isEstimated(provider) ? " (est.)" : ""}` : resetCountdown(provider, asOfMs)}
          </div>
        </div>
      </div>

      {quota?.sessionPct !== undefined && quota.sessionPct !== null && (
        <div style={{ font: "var(--t-2)", marginTop: 4 }}>Session use {quota.sessionPct}%</div>
      )}
      {evidence.length > 0 && (
        <div style={{ font: "var(--t-1)", marginTop: 4 }}>{evidence.join(" · ")}</div>
      )}

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 8,
          font: "var(--t-2)",
        }}
      >
        <span>{resetsDate(provider) ?? resetCountdown(provider, asOfMs)}</span>
        <span aria-hidden="true">Inspect →</span>
      </div>
    </article>
  );
}
