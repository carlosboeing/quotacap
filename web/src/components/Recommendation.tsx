import React from "react";
import type {
  AdvisoryView,
  ExclusionReason,
  ProviderView,
  RecommendationView,
  Urgency,
} from "../state.js";
import { displayName } from "../names.js";
import { timeLeft } from "./PaceBar.js";

export type Lane = "use-more" | "ease-off";

/**
 * Lane membership from server urgency only. Any exclusionReason keeps the
 * provider out of both lanes; "on track" belongs to neither lane.
 */
export function laneOf(
  advisory: { urgency: Urgency },
  exclusionReason: ExclusionReason
): Lane | null {
  if (exclusionReason !== null) return null;
  switch (advisory.urgency) {
    case "burn now":
    case "use soon":
    case "save":
      return "use-more";
    case "slow down":
      return "ease-off";
    case "on track":
      return null;
  }
}

export interface LaneMembership {
  useMore: AdvisoryView[];
  easeOff: AdvisoryView[];
}

/** Group advisories into lanes, joining each to its provider exclusion flag. */
export function lanesFor(
  advisories: AdvisoryView[],
  providers: ProviderView[]
): LaneMembership {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const useMore: AdvisoryView[] = [];
  const easeOff: AdvisoryView[] = [];
  for (const advisory of advisories) {
    const provider = byId.get(advisory.provider);
    if (!provider) continue;
    const lane = laneOf(advisory, provider.exclusionReason);
    if (lane === "use-more") useMore.push(advisory);
    else if (lane === "ease-off") easeOff.push(advisory);
  }
  return { useMore, easeOff };
}

function LaneSection({
  testId,
  label,
  tintClass,
  laneClass,
  icon,
  members,
  providers,
  asOfMs,
  onSelectProvider,
}: {
  testId: string;
  label: string;
  tintClass: string;
  laneClass: string;
  icon: React.ReactNode;
  members: AdvisoryView[];
  providers: ProviderView[];
  asOfMs: number;
  onSelectProvider?: (id: string) => void;
}) {
  if (members.length === 0) return null;
  const byId = new Map(providers.map((p) => [p.id, p]));
  return (
    <div data-testid={testId} aria-label={label} className={`lane ${tintClass}`}>
      <span className={`lane-l ${laneClass}`}>
        {icon}
        {label}
      </span>
      <div className="items">
        {members.map((m) => {
          const quota = byId.get(m.provider)?.quota;
          const left = quota ? timeLeft(quota.resetsAt, asOfMs) : null;
          const name = displayName(m.provider);
          return (
            <div key={m.provider} className="rsub">
              <span
                className="sq"
                style={{
                  background: `var(--p-${m.provider}, var(--surface-raised))`,
                  color: "#fff",
                }}
                aria-hidden="true"
              >
                {name.charAt(0)}
              </span>
              <div className="rnm-group">
                <button
                  type="button"
                  className="rnm"
                  onClick={() => onSelectProvider?.(m.provider)}
                  aria-label={`View ${name} details`}
                >
                  {name}
                </button>
              </div>
              <span className="rnum">
                {quota ? <b>{quota.usedPct}%</b> : ""}
                {quota && left ? " · " : ""}
                {left ? `${left} left` : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Lead prose plus USE MORE / EASE OFF lanes. Prints the server reason
 * verbatim and never computes a forecast. No advice-engine drawer: lane
 * names open the provider drawer instead.
 */
export function Recommendation({
  recommendation,
  providers,
  asOf,
  onSelectProvider,
}: {
  recommendation: RecommendationView;
  providers: ProviderView[];
  asOf: string;
  onSelectProvider?: (id: string) => void;
}) {
  const { useMore, easeOff } = lanesFor(recommendation.advisories, providers);
  const asOfMs = Date.parse(asOf);
  const measuring = recommendation.use !== "none" && recommendation.wastePct === null;
  const isClear = recommendation.use === "none" && useMore.length === 0 && easeOff.length === 0;

  if (isClear) {
    return (
      <section
        data-testid="recommendation"
        aria-label="Recommendation"
        className="recwrap is-clear"
        role="status"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z" />
          <path d="M8 12.5l2.8 2.8L16 10" />
        </svg>
        <div>
          <b>No subscription needs priority</b>
          <span data-testid="rec-prose">{recommendation.reason}</span>
        </div>
      </section>
    );
  }

  return (
    <section
      data-testid="recommendation"
      aria-label="Recommendation"
      className="recwrap"
      role="status"
    >
      <div className="rec-top">
        <div className="rec-lead">
          <span className="rec-badge">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
            </svg>
            Recommendation
          </span>
          {recommendation.use === "none" ? (
            <p className="rec-advice-prose" data-testid="rec-prose">
              {recommendation.reason}
            </p>
          ) : (
            <p className="rec-advice-prose" data-testid="rec-prose">
              Switch to <strong>{displayName(recommendation.use)}</strong> next — {recommendation.reason}
            </p>
          )}
          {measuring && (
            <span
              className="rec-badge"
              data-testid="rec-measuring"
              style={{
                background: "var(--ahead-soft)",
                color: "var(--ahead)",
                borderColor: "var(--ahead)",
              }}
            >
              measuring pace
            </span>
          )}
        </div>
      </div>
      {(useMore.length > 0 || easeOff.length > 0) && (
        <div className="recB">
          <LaneSection
            testId="lane-use-more"
            label="USE MORE"
            tintClass="tint-ahead"
            laneClass="l-ahead"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="18 15 12 9 6 15" />
              </svg>
            }
            members={useMore}
            providers={providers}
            asOfMs={asOfMs}
            onSelectProvider={onSelectProvider}
          />
          <LaneSection
            testId="lane-ease-off"
            label="EASE OFF"
            tintClass="tint-behind"
            laneClass="l-behind"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            }
            members={easeOff}
            providers={providers}
            asOfMs={asOfMs}
            onSelectProvider={onSelectProvider}
          />
        </div>
      )}
    </section>
  );
}
