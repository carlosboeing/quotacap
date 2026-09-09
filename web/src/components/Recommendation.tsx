import React from "react";
import type {
  AdvisoryView,
  ExclusionReason,
  ProviderView,
  RecommendationView,
  Urgency,
} from "../state.js";
import { displayName } from "../names.js";

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
  members,
  onSelectProvider,
}: {
  testId: string;
  label: string;
  members: AdvisoryView[];
  onSelectProvider?: (id: string) => void;
}) {
  if (members.length === 0) return null;
  return (
    <section data-testid={testId} aria-label={label}>
      <h3>{label}</h3>
      <ul>
        {members.map((m) => (
          <li key={m.provider}>
            <button type="button" onClick={() => onSelectProvider?.(m.provider)}>
              {displayName(m.provider)}
            </button>
          </li>
        ))}
      </ul>
    </section>
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
  onSelectProvider,
}: {
  recommendation: RecommendationView;
  providers: ProviderView[];
  onSelectProvider?: (id: string) => void;
}) {
  const { useMore, easeOff } = lanesFor(recommendation.advisories, providers);
  const measuring = recommendation.use !== "none" && recommendation.wastePct === null;
  return (
    <section
      data-testid="recommendation"
      aria-label="Recommendation"
      style={{ borderLeft: "4px solid var(--rec)", paddingLeft: 12 }}
    >
      {recommendation.use === "none" ? (
        <p data-testid="rec-prose">{recommendation.reason}</p>
      ) : (
        <p data-testid="rec-prose">
          Switch to <strong>{displayName(recommendation.use)}</strong> next — {recommendation.reason}
        </p>
      )}
      {measuring && <span data-testid="rec-measuring">measuring pace</span>}
      <LaneSection testId="lane-use-more" label="USE MORE" members={useMore} onSelectProvider={onSelectProvider} />
      <LaneSection testId="lane-ease-off" label="EASE OFF" members={easeOff} onSelectProvider={onSelectProvider} />
    </section>
  );
}
