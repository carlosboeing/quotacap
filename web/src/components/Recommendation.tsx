import React from "react";
import type {
  AdvisoryView,
  ExclusionReason,
  ProviderView,
  RecommendationView,
  Urgency,
} from "../state.js";
import { ageLabel } from "../state.js";
import { displayName } from "../names.js";
import { timeLeft } from "./PaceBar.js";
import { ProviderIcon, providerTint } from "./ProviderIcon.js";

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
              <span className="sq" style={providerTint(m.provider)} aria-hidden="true">
                <ProviderIcon id={m.provider} title={name} size={13} />
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
                {quota ? (
                  <>
                    <b>{quota.usedPct}%</b> used
                    {left ? (
                      <>
                        {" · "}
                        <b>{left}</b> left
                      </>
                    ) : null}
                  </>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Lead prose plus USE MORE / EASE OFF lanes. View advice opens the
 * advice drawer. Lane names still open the provider drawer.
 */
export function Recommendation({
  recommendation,
  providers,
  asOf,
  onSelectProvider,
  onViewAdvice,
}: {
  recommendation: RecommendationView;
  providers: ProviderView[];
  asOf: string;
  onSelectProvider?: (id: string) => void;
  onViewAdvice?: () => void;
}) {
  const { useMore, easeOff } = lanesFor(recommendation.advisories, providers);
  const asOfMs = Date.parse(asOf);
  const measuring = recommendation.use !== "none" && recommendation.wastePct === null;
  const isClear = recommendation.use === "none" && useMore.length === 0 && easeOff.length === 0;
  const tracked = providers.filter((p) => p.enabled && p.id !== "manual").length;
  const easeTint = easeOff.some((a) => a.status === "at risk") ? "tint-cap" : "tint-ahead";
  const pick = providers.find((p) => p.id === recommendation.use);
  const pickLeft = pick?.quota ? timeLeft(pick.quota.resetsAt, asOfMs) : null;
  const openAdvice = () => {
    onViewAdvice?.();
  };

  const head = (
    <div className="section-head">
      <h2>Quota Advice & Pacing</h2>
      <span className="note">
        {tracked} tracked · {ageLabel(asOf)}
      </span>
    </div>
  );

  if (isClear) {
    return (
      <section aria-label="Quota advice and pacing">
        {head}
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
      </section>
    );
  }

  return (
    <section aria-label="Quota advice and pacing">
      {head}
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
              <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" />
            </svg>
            Recommendation
          </span>
          {recommendation.use === "none" ? (
            <p className="rec-advice-prose" data-testid="rec-prose">
              {recommendation.reason}
            </p>
          ) : (
            <p className="rec-advice-prose" data-testid="rec-prose">
              Switch to <strong>{displayName(recommendation.use)}</strong> next
              {recommendation.wastePct !== null ? (
                <>
                  {" — "}
                  <strong>{Math.round(recommendation.wastePct)}%</strong> unused quota forecast
                  {pickLeft ? <> to expire in <strong>{pickLeft}</strong></> : null}.
                </>
              ) : (
                <> — {recommendation.reason}</>
              )}
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
        {recommendation.use !== "none" && (
          <button
            type="button"
            className="btn"
            data-testid="view-advice"
            title="Open recommended provider"
            onClick={openAdvice}
          >
            View advice
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        )}
      </div>
      {(useMore.length > 0 || easeOff.length > 0) && (
        <div className="recB">
          <LaneSection
            testId="lane-use-more"
            label="Use more"
            tintClass="tint-behind"
            laneClass="l-behind"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20V5M6 11l6-6 6 6" />
              </svg>
            }
            members={useMore}
            providers={providers}
            asOfMs={asOfMs}
            onSelectProvider={onSelectProvider}
          />
          <LaneSection
            testId="lane-ease-off"
            label="Ease off"
            tintClass={easeTint}
            laneClass={easeTint === "tint-cap" ? "l-cap" : "l-ahead"}
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 4v15M6 13l6 6 6-6" />
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
    </section>
  );
}
