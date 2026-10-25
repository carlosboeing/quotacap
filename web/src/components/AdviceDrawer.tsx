import React, { useEffect, useRef } from "react";
import type { AdvisoryView, ProviderView, RecommendationView } from "../state.js";
import { quotaResetsAt, quotaUsedPct, timeLeft } from "./PaceBar.js";
import { clockText } from "../../../src/format/time.js";
import { ProviderIcon, providerTint } from "./ProviderIcon.js";
import { lanesFor } from "./Recommendation.js";
import { CopyButton } from "./CopyButton.js";

/** Names the rate the forecast is priced at, matching the engine's blend inputs. */
export function forecastBasisWords(advisory: AdvisoryView | null | undefined): string {
  if (!advisory) return "forecast pace";
  const recent = advisory.recentRate ?? null;
  const baseline = advisory.baselineRate ?? null;
  if (recent !== null && baseline !== null) return "24h pace blended with history";
  if (recent !== null || advisory.paceSource === "recent") return "24h pace";
  if (advisory.paceSource === "window-average") return "window-average pace";
  return "forecast pace";
}

export function AdviceDrawer({
  open,
  recommendation,
  providers,
  asOf,
  onClose,
  onSelectProvider,
}: {
  open: boolean;
  recommendation: RecommendationView;
  providers: ProviderView[];
  asOf: string;
  onClose: () => void;
  onSelectProvider?: (id: string) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      const list = [...focusables].filter((el) => !el.hasAttribute("disabled"));
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const atStart =
        document.activeElement === first || document.activeElement === dialogRef.current;
      if (e.shiftKey && atStart) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      (previouslyFocused.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const asOfMs = Date.parse(asOf);
  const { useMore, easeOff } = lanesFor(recommendation.advisories, providers);
  const pickId = recommendation.use !== "none" ? recommendation.use : useMore[0]?.provider;
  const pick = pickId ? providers.find((p) => p.id === pickId) : undefined;
  const pickName = pick ? pick.displayName : null;
  const remaining =
    pick?.advisory
      ? Math.round(
          pick.advisory.bindingWindow === "monthly"
            ? pick.advisory.bindingRemaining
            : pick.advisory.remaining,
        )
      : null;
  // A monthly-bound pick's leftover is unusable until the month resets, so
  // the weekly expiry sentence would restate issue 109; show the reason.
  const monthlyBound =
    recommendation.bindingWindow === "monthly" || pick?.advisory?.bindingWindow === "monthly";
  const waste = monthlyBound
    ? null
    : recommendation.wastePct !== null
      ? Math.round(recommendation.wastePct)
      : pick?.advisory?.wastePct !== null && pick?.advisory?.wastePct !== undefined
        ? Math.round(pick.advisory.wastePct)
        : null;
  const pickReset = pick ? quotaResetsAt(pick) : null;
  const left = pickReset ? timeLeft(pickReset, asOfMs) : null;
  const pickClock = clockText(pickReset, asOfMs);
  const basis = forecastBasisWords(pick?.advisory);
  const othersMore = useMore.filter((a) => a.provider !== pickId);
  const titleId = "advice-drawer-title";

  return (
    <>
      <div
        data-testid="advice-scrim"
        className="scrim is-open"
        aria-hidden="true"
        onClick={onClose}
      />
      <aside
        ref={dialogRef}
        tabIndex={-1}
        data-testid="advice-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="drawer is-open"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <span className="picon rec-picon" aria-hidden="true">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" />
            </svg>
          </span>
          <div style={{ flex: 1 }}>
            <h2 id={titleId}>Quota Advice &amp; Pacing</h2>
            <span className="sub">Which quota to burn next, and why</span>
          </div>
          <button
            className="drawer-close"
            type="button"
            aria-label="Close advice"
            onClick={onClose}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="dsec">
          <h3>Recommended for next session</h3>
          {pick && pickName ? (
            <div className="advice-card" style={{ marginTop: 8 }}>
              <div className="advice-card-main">
                <div className="advice-card-lead">
                  <span className="sq" style={providerTint(pick.id)}>
                    <ProviderIcon id={pick.id} title={pickName} size={16} />
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="name">{pickName}</span>
                    <span className="recommended-badge">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" />
                      </svg>
                      Recommended
                    </span>
                  </div>
                </div>
                {waste !== null && left && (
                  <div className="advice-card-stats">
                    <b>{waste}%</b> unused at reset{pickClock ? <> (<b>{pickClock}</b>)</> : null}
                  </div>
                )}
              </div>
              <p className="advice-card-body">
                {remaining !== null && left && !monthlyBound ? (
                  <>
                    <b>{pickName}</b> has {remaining}% quota remaining with {left} to reset, forecast at the {basis}.
                  </>
                ) : (
                  recommendation.reason
                )}
              </p>
              {onSelectProvider && (
                <div>
                  <button
                    type="button"
                    className="goto-link"
                    onClick={() => onSelectProvider(pick.id)}
                  >
                    View {pickName} details →
                  </button>
                </div>
              )}
            </div>
          ) : (
            <p className="advice-card-body">{recommendation.reason}</p>
          )}
        </div>

        <div className="dsec">
          <h3>Fleet Pacing Breakdown</h3>
          <dl className="lane-group">
            <dt className="um">
              <span aria-hidden="true">↑</span> Use more
            </dt>
            <dd>
              {othersMore.length
                ? othersMore.map((a) => {
                    const p = providers.find((x) => x.id === a.provider);
                    const name = p?.displayName ?? a.provider;
                    // A month-bound row reads the month, like its card.
                    const unused =
                      a.bindingWindow === "monthly"
                        ? `${Math.round(a.bindingRemaining)}% of month left`
                        : a.wastePct !== null
                          ? `${Math.round(a.wastePct)}% unused at reset`
                          : null;
                    const resetIso = p ? quotaResetsAt(p) : null;
                    const t = resetIso ? timeLeft(resetIso, asOfMs) : null;
                    const meta = [unused, t ? `resets in ${t}` : null].filter(Boolean).join(" · ");
                    return (
                      <div key={a.provider} className="lane-row">
                        <span className="nm">{name}</span>
                        <span className="meta">{meta}</span>
                      </div>
                    );
                  })
                : "None"}
            </dd>
            <dt className="eo">
              <span aria-hidden="true">↓</span> Ease off
            </dt>
            <dd>
              {easeOff.length
                ? easeOff.map((a) => {
                    const p = providers.find((x) => x.id === a.provider);
                    const name = p?.displayName ?? a.provider;
                    const usedRaw = p ? quotaUsedPct(p) : null;
                    const used = usedRaw !== null ? `${Math.round(usedRaw)}% used` : null;
                    const resetIso2 = p ? quotaResetsAt(p) : null;
                    const t = resetIso2 ? timeLeft(resetIso2, asOfMs) : null;
                    const meta = [used, t ? `resets in ${t}` : null].filter(Boolean).join(" · ");
                    return (
                      <div key={a.provider} className="lane-row">
                        <span className="nm">{name}</span>
                        <span className="meta">{meta}</span>
                      </div>
                    );
                  })
                : "None"}
            </dd>
          </dl>
        </div>

        <div className="dsec">
          <h3>CLI Command</h3>
          <div className="cli-wrap">
            <pre className="advice-cli">
              <code>$ quotacap advise</code>
            </pre>
            <CopyButton text="quotacap advise" />
          </div>
        </div>
      </aside>
    </>
  );
}
