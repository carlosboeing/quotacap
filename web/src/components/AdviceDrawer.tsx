import React, { useEffect, useRef } from "react";
import type { ProviderView, RecommendationView } from "../state.js";
import { displayName } from "../names.js";
import { paceBadge, timeLeft } from "./PaceBar.js";
import { ProviderIcon, providerTint } from "./ProviderIcon.js";
import { lanesFor } from "./Recommendation.js";

export function AdviceDrawer({
  open,
  recommendation,
  providers,
  asOf,
  onClose,
}: {
  open: boolean;
  recommendation: RecommendationView;
  providers: ProviderView[];
  asOf: string;
  onClose: () => void;
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
  const pickName = pick ? displayName(pick.id) : null;
  const remaining =
    pick?.advisory?.remaining !== null && pick?.advisory?.remaining !== undefined
      ? Math.round(pick.advisory.remaining)
      : null;
  const waste =
    recommendation.wastePct !== null
      ? Math.round(recommendation.wastePct)
      : pick?.advisory?.wastePct !== null && pick?.advisory?.wastePct !== undefined
        ? Math.round(pick.advisory.wastePct)
        : null;
  const left = pick?.quota ? timeLeft(pick.quota.resetsAt, asOfMs) : null;
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
            <span className="sub">Actionable recommendations based on quota pacing &amp; reset schedules</span>
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
                    <b>{waste}%</b> unused quota expires in <b>{left}</b>
                  </div>
                )}
              </div>
              <p className="advice-card-body">
                {remaining !== null && left && waste !== null ? (
                  <>
                    <b>{pickName}</b> has {remaining}% quota remaining with its reset window closing in {left}.
                    Current pacing projects {waste}% unused quota at reset. Using this subscription now avoids unused quota expiration.
                  </>
                ) : (
                  recommendation.reason
                )}
              </p>
            </div>
          ) : (
            <p className="advice-card-body">{recommendation.reason}</p>
          )}
        </div>

        <div className="dsec">
          <h3>Fleet Pacing Breakdown</h3>
          <dl className="dkv">
            <dt>Use more</dt>
            <dd>
              {othersMore.length
                ? othersMore.map((a, i) => {
                    const p = providers.find((x) => x.id === a.provider);
                    const w = a.wastePct !== null ? `${Math.round(a.wastePct)}% unused` : null;
                    const t = p?.quota ? timeLeft(p.quota.resetsAt, asOfMs) : null;
                    const bits = [w, t ? `resets in ${t}` : null].filter(Boolean).join(" · ");
                    return (
                      <span key={a.provider}>
                        {i > 0 ? ", " : ""}
                        <b>{displayName(a.provider)}</b>
                        {bits ? ` (${bits})` : ""}
                      </span>
                    );
                  })
                : "None"}
            </dd>
            <dt>Ease off</dt>
            <dd>
              {easeOff.length
                ? easeOff.map((a, i) => {
                    const p = providers.find((x) => x.id === a.provider);
                    const badge = p ? paceBadge(p) : a.urgency;
                    return (
                      <span key={a.provider}>
                        {i > 0 ? ", " : ""}
                        <b>{displayName(a.provider)}</b> ({badge})
                      </span>
                    );
                  })
                : "None"}
            </dd>
          </dl>
        </div>

        <div className="dsec">
          <h3>CLI Command</h3>
          <p style={{ fontSize: "var(--t-2)", color: "var(--ink-soft)", marginBottom: 8 }}>
            Equivalent terminal command:
          </p>
          <pre className="advice-cli">
            <code>$ quotacap advise</code>
          </pre>
        </div>
      </aside>
    </>
  );
}
