import React, { useEffect, useState } from "react";
import type { ProviderView, RecommendationView } from "../state.js";
import { ageLabel } from "../state.js";
import { displayName } from "../names.js";
import { lanesFor } from "./Recommendation.js";
import { ProviderCard } from "./ProviderCard.js";
import { ProviderRow } from "./ProviderRow.js";
import { PacingLegend } from "./PacingLegend.js";
import { resetCountdown } from "./PaceBar.js";

export type SortKey = "recommended" | "reset-asc" | "reset-desc" | "used-desc" | "used-asc";
export type Density = "cards" | "table";

/**
 * Sort over server fields only. Recommended puts the server pick first, then
 * lane members, then the rest in server order, excluded last. Sort is stable.
 */
export function sortProviders(
  providers: ProviderView[],
  key: SortKey,
  recommendation: RecommendationView
): ProviderView[] {
  const list = [...providers];
  if (key === "recommended") {
    const { useMore, easeOff } = lanesFor(recommendation.advisories, providers);
    const order = new Map<string, number>();
    let rank = 0;
    if (recommendation.use !== "none") order.set(recommendation.use, rank++);
    for (const a of [...useMore, ...easeOff]) {
      if (!order.has(a.provider)) order.set(a.provider, rank++);
    }
    const ranked = list
      .filter((p) => p.exclusionReason === null && order.has(p.id))
      .sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    const rest = list.filter((p) => p.exclusionReason === null && !order.has(p.id));
    const excluded = list.filter((p) => p.exclusionReason !== null);
    return [...ranked, ...rest, ...excluded];
  }
  const resetMs = (p: ProviderView): number => (p.quota ? Date.parse(p.quota.resetsAt) : NaN);
  const used = (p: ProviderView): number => (p.quota ? p.quota.usedPct : NaN);
  const withInvalidLast = (cmp: (a: number, b: number) => number, value: (p: ProviderView) => number) =>
    list.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      const aBad = !Number.isFinite(va);
      const bBad = !Number.isFinite(vb);
      if (aBad && bBad) return 0;
      if (aBad) return 1;
      if (bBad) return -1;
      return cmp(va, vb);
    });
  switch (key) {
    case "reset-asc":
      return withInvalidLast((a, b) => a - b, resetMs);
    case "reset-desc":
      return withInvalidLast((a, b) => b - a, resetMs);
    case "used-desc":
      return withInvalidLast((a, b) => b - a, used);
    case "used-asc":
      return withInvalidLast((a, b) => a - b, used);
  }
}

/** Narrow viewports force Cards; the stored choice returns on wider layouts. */
export function effectiveDensity(choice: Density, isNarrow: boolean): Density {
  return isNarrow ? "cards" : choice;
}

function useNarrow(): boolean {
  const query = "(max-width: 639px)";
  const [narrow, setNarrow] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "recommended", label: "Recommended" },
  { value: "reset-asc", label: "Resets soonest" },
  { value: "reset-desc", label: "Resets furthest" },
  { value: "used-desc", label: "Used most" },
  { value: "used-asc", label: "Used least" },
];

export function SubscriptionList({
  providers,
  recommendation,
  asOf,
  onSelectProvider,
}: {
  providers: ProviderView[];
  recommendation: RecommendationView;
  asOf: string;
  onSelectProvider: (id: string) => void;
}) {
  const [density, setDensity] = useState<Density>("cards");
  const [sortKey, setSortKey] = useState<SortKey>("recommended");
  const narrow = useNarrow();
  const effective = effectiveDensity(density, narrow);
  const sorted = sortProviders(providers, sortKey, recommendation);
  const enabled = sorted.filter((p) => p.enabled);
  const disabled = sorted.filter((p) => !p.enabled);
  const asOfMs = Date.parse(asOf);
  return (
    <section aria-label="Subscriptions">
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div role="group" aria-label="Density">
          <button
            type="button"
            aria-pressed={effective === "cards"}
            onClick={() => setDensity("cards")}
          >
            Cards
          </button>
          {!narrow && (
            <button
              type="button"
              aria-pressed={effective === "table"}
              onClick={() => setDensity("table")}
            >
              Table
            </button>
          )}
        </div>
        <label>
          Sort:{" "}
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <PacingLegend />
      </div>
      <p>
        {enabled.length} tracked · {ageLabel(asOf)}
      </p>
      {effective === "cards" ? (
        <div data-testid="cards-grid" className="cards-grid">
          {enabled.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              recommended={p.id === recommendation.use}
              asOf={asOf}
              onSelect={onSelectProvider}
            />
          ))}
        </div>
      ) : (
        <div className="table-scroll">
          <table data-testid="ledger-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Used</th>
                <th>Resets</th>
                <th>State</th>
                <th>Forecast</th>
              </tr>
            </thead>
            <tbody>
              {enabled.map((p) => (
                <ProviderRow
                  key={p.id}
                  provider={p}
                  recommended={p.id === recommendation.use}
                  asOf={asOf}
                  onSelect={onSelectProvider}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {disabled.length > 0 && (
        <section aria-label="Disabled providers">
          <h3>Disabled ({disabled.length})</h3>
          <ul>
            {disabled.map((p) => (
              <li key={p.id} style={{ font: "var(--t-2)" }}>
                {displayName(p.id)} · disabled · {resetCountdown(p, asOfMs)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
