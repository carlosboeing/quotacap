import React, { useEffect, useRef, useState } from "react";
import type { ProviderView, RecommendationView, RuntimeView } from "../state.js";
import { nextRefreshLabel } from "../state.js";
import { lanesFor } from "./Recommendation.js";
import { ProviderCard } from "./ProviderCard.js";
import { ProviderRow } from "./ProviderRow.js";
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

/** Density follows the control at every width — the prototype keeps Cards and Table visible on mobile. */
export function effectiveDensity(choice: Density, _isNarrow: boolean): Density {
  return choice;
}

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "recommended", label: "Recommended" },
  { value: "reset-asc", label: "Earliest Reset" },
  { value: "reset-desc", label: "Latest Reset" },
  { value: "used-desc", label: "Highest Usage" },
  { value: "used-asc", label: "Lowest Usage" },
];

function SortDropdown({
  value,
  onChange,
}: {
  value: SortKey;
  onChange: (key: SortKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = SORT_OPTIONS.find((o) => o.value === value) ?? SORT_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="sort-dropdown" ref={rootRef}>
      <button
        type="button"
        className="sort-btn"
        data-testid="sort-select"
        aria-label="Sort by"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="sort-icon" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="12" x2="14" y2="12" />
            <line x1="4" y1="18" x2="8" y2="18" />
          </svg>
        </span>
        <span className="sort-display">
          <span className="sort-prefix">Sort by:</span>
          <span className="sort-val">{current.label}</span>
        </span>
        <svg className="sort-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="sort-menu" role="listbox" aria-label="Sort subscriptions">
          {SORT_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              className={`sort-option${o.value === value ? " is-active" : ""}`}
              aria-selected={o.value === value}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span>{o.label}</span>
              <svg className="check-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SubscriptionList({
  providers,
  recommendation,
  asOf,
  lastCompletedPollAt,
  polling,
  onSelectProvider,
}: {
  providers: ProviderView[];
  recommendation: RecommendationView;
  asOf: string;
  lastCompletedPollAt: string | null;
  polling: RuntimeView["polling"];
  onSelectProvider: (id: string) => void;
}) {
  const [density, setDensity] = useState<Density>("cards");
  const [sortKey, setSortKey] = useState<SortKey>("recommended");
  const effective = effectiveDensity(density, false);
  const sorted = sortProviders(providers, sortKey, recommendation);
  const enabled = sorted.filter((p) => p.enabled && (p.id !== "manual" || p.quota !== null));
  const disabled = sorted.filter((p) => !p.enabled && p.id !== "manual");
  const asOfMs = Date.parse(asOf);
  const ranked = enabled.filter((p) => p.exclusionReason === null);
  const excluded = enabled.filter((p) => p.exclusionReason !== null);
  return (
    <section aria-label="Subscriptions">
      <div className="section-head">
        <h2>All subscriptions</h2>
        <div className="section-head-controls">
          <SortDropdown value={sortKey} onChange={setSortKey} />
          <div role="group" aria-label="Display density" className="seg">
            <button
              type="button"
              aria-pressed={effective === "cards"}
              onClick={() => setDensity("cards")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="3" y="3" width="8" height="8" rx="2" />
                <rect x="13" y="3" width="8" height="8" rx="2" />
                <rect x="3" y="13" width="8" height="8" rx="2" />
                <rect x="13" y="13" width="8" height="8" rx="2" />
              </svg>
              Cards
            </button>
            <button
              type="button"
              aria-pressed={effective === "table"}
              onClick={() => setDensity("table")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="3" y="5" width="18" height="2.6" rx="1.3" />
                <rect x="3" y="11" width="18" height="2.6" rx="1.3" />
                <rect x="3" y="17" width="18" height="2.6" rx="1.3" />
              </svg>
              Table
            </button>
          </div>
        </div>
      </div>

      {effective === "cards" ? (
        <div data-testid="cards-grid" className="cards cards-grid">
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
          <div data-testid="ledger-table" className="ledger" role="table">
            <div className="lrow lhead" role="row">
              <span role="columnheader">Provider</span>
              <span role="columnheader">Used vs elapsed</span>
              <span role="columnheader">Resets in</span>
              <span role="columnheader">Pace</span>
              <span role="columnheader" />
            </div>
            {enabled.map((p) => (
              <ProviderRow
                key={p.id}
                provider={p}
                recommended={p.id === recommendation.use}
                asOf={asOf}
                onSelect={onSelectProvider}
              />
            ))}
          </div>
        </div>
      )}

      <footer className="health">
        <ul>
          <li className="legend-rec">
            <svg className="legend-star" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" />
            </svg>
            <span>Recommended to use next</span>
          </li>
          <li>
            <span className="dot" style={{ background: "var(--good)" }} />
            <span>{ranked.length} used in ranking</span>
          </li>
          {excluded.length > 0 && (
            <li>
              <span className="dot" style={{ background: "var(--fill-out)" }} />
              <span>
                {excluded.length} not reporting
                {excluded.length <= 2 ? ` · ${excluded.map((p) => p.displayName).join(", ")}` : ""}
              </span>
            </li>
          )}
        </ul>
        <span>{nextRefreshLabel(lastCompletedPollAt, polling)}</span>
      </footer>

      {disabled.length > 0 && (
        <section aria-label="Disabled providers">
          <h3>Disabled ({disabled.length})</h3>
          <ul>
            {disabled.map((p) => (
              <li key={p.id} style={{ fontSize: "var(--t-2)" }}>
                {p.displayName} · disabled · {resetCountdown(p, asOfMs)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
