import React, { useEffect, useRef, useState } from "react";

import type {
  ExclusionReason,
  FailureCategory,
  PaceSource,
  ProviderView,
  RecommendationView,
} from "../state.js";
import { ageDuration, providerSubtitle } from "../state.js";
import {
  Badge,
  PaceBar,
  barGeometry,
  isEstimated,
  paceBadge,
  resetClock,
  timeLeft,
  type PaceBadge,
} from "./PaceBar.js";
import { ProviderIcon, providerTint } from "./ProviderIcon.js";

export interface DrawerModel {
  id: string;
  name: string;
  badge: PaceBadge;
  burnRate: number | null;
  idealRate: number | null;
  paceSource: PaceSource | null;
  /** "Measured" or "Window avg"; null while pace is unknown. */
  paceLabel: string | null;
  daysLeft: number | null;
  daysToExhaust: number | null;
  remaining: number | null;
  wastePct: number | null;
  periodStart: string | null;
  resetsAt: string | null;
  estimatedReset: boolean;
  lastSuccessAt: string | null;
  ageMs: number | null;
  failureCategory: FailureCategory;
  failureWords: string | null;
  evidence: string[];
  exclusionReason: ExclusionReason;
  exclusionWords: string | null;
  sessionPct?: number;
  /** Type-level guard: a session reset is never synthesized, so this stays absent. */
  sessionReset?: undefined;
}

export function exclusionWords(reason: ExclusionReason): string | null {
  switch (reason) {
    case "not-reporting":
      return "Not reporting yet.";
    case "stale":
      return "Stale — excluded from ranking.";
    case "reset-passed":
      return "Reset passed — awaiting a fresh window.";
    case "invalid":
      return "Reading invalid — excluded from ranking.";
    case "provider-failed":
      return "Provider failed — excluded from ranking.";
    case null:
      return null;
  }
}

export function failureWords(category: FailureCategory): string | null {
  switch (category) {
    case "auth":
      return "Authentication failed";
    case "timeout":
      return "Timed out";
    case "parse":
      return "Unreadable output";
    case "network":
      return "Network error";
    case "skipped":
      return "Skipped";
    case "unknown":
      return "Unknown error";
    case null:
      return null;
  }
}

/** Drawer fields copied from the server snapshot. Nothing is synthesized. */
export function drawerModel(provider: ProviderView): DrawerModel {
  const advisory = provider.advisory;
  const model: DrawerModel = {
    id: provider.id,
    name: provider.displayName,
    badge: paceBadge(provider),
    burnRate: advisory?.burnRate ?? null,
    idealRate: advisory ? advisory.idealRate : null,
    paceSource: advisory ? advisory.paceSource : null,
    paceLabel:
      advisory && advisory.burnMeasured
        ? "Measured"
        : advisory && advisory.paceSource === "window-average"
          ? "Window avg"
          : null,
    daysLeft: advisory ? advisory.daysLeft : null,
    daysToExhaust: advisory?.daysToExhaust ?? null,
    remaining: advisory ? advisory.remaining : null,
    wastePct: advisory?.wastePct ?? null,
    periodStart: provider.quota ? provider.quota.periodStart : null,
    resetsAt: provider.quota ? provider.quota.resetsAt : null,
    estimatedReset: provider.evidence.includes("estimated-reset"),
    lastSuccessAt: provider.lastSuccessAt,
    ageMs: provider.ageMs,
    failureCategory: provider.lastAttempt?.failureCategory ?? null,
    failureWords: failureWords(provider.lastAttempt?.failureCategory ?? null),
    evidence: [...provider.evidence],
    exclusionReason: provider.exclusionReason,
    exclusionWords: exclusionWords(provider.exclusionReason),
  };
  if (provider.quota?.sessionPct !== undefined && provider.quota.sessionPct !== null) {
    model.sessionPct = provider.quota.sessionPct;
  }
  return model;
}

export function sourceLabel(source: string | undefined | null): string {
  switch (source) {
    case "cli":
      return "Live CLI";
    case "api":
      return "Live API";
    case "tui":
      return "Live TUI";
    case "scrape":
      return "Live scrape";
    case "manual":
      return "Manual ingest";
    default:
      return source || "unknown";
  }
}

export function paceBasis(provider: ProviderView, asOfMs?: number): string {
  const advisory = provider.advisory;
  if (!advisory || advisory.paceSource === "unknown") return "No current reading";
  const start = provider.quota ? Date.parse(provider.quota.periodStart) : NaN;
  if (Number.isFinite(start) && Number.isFinite(asOfMs) && (asOfMs as number) > start) {
    const days = ((asOfMs as number) - start) / 86_400_000;
    if (days >= 0.1) return `averaged over ${days.toFixed(1)} days of this window`;
  }
  if (provider.evidence.includes("measured") || advisory.burnMeasured) return "Measured";
  if (advisory.paceSource === "window-average" || provider.evidence.includes("window-average")) {
    return "Window avg";
  }
  return "No current reading";
}

export function credentialLabel(provider: ProviderView): string {
  const source = provider.quota?.source;
  if (source === "cli" || source === "tui") return `handled by ${provider.displayName}`;
  return "not stored by QuotaCap";
}

export function pacingStatusToken(provider: ProviderView): string {
  switch (paceBadge(provider)) {
    case "Behind pace":
      return "behind";
    case "On track":
      return "ontrack";
    case "Ahead of pace":
      return "ahead";
    case "Cap risk":
      return "cap";
    case "Not reporting":
      return "out";
  }
}

export function resetStamp(provider: ProviderView): string | null {
  if (!provider.quota) return null;
  const clock = resetClock(provider.quota.resetsAt);
  if (!clock) return null;
  return `${clock}${isEstimated(provider) ? " (est.)" : ""}`;
}

export function resetUnderline(provider: ProviderView, asOfMs: number): string | null {
  const stamp = resetStamp(provider);
  if (!stamp || !provider.quota) return null;
  const left = timeLeft(provider.quota.resetsAt, asOfMs);
  return left ? `Resets ${stamp} · in ${left}` : `Resets ${stamp}`;
}

export function rankingCopy(
  provider: ProviderView,
  recommendation: RecommendationView | null
): { known: string; pace: string; decision: string } {
  const name = provider.displayName;
  const quota = provider.quota;
  const advisory = provider.advisory;
  const stamp = resetStamp(provider);
  const known = quota
    ? `${name} reports ${quota.usedPct}% of quota used.${stamp ? ` Resets ${stamp}.` : ""}`
    : "No reading yet.";
  let pace: string;
  if (!advisory || advisory.paceSource === "unknown" || advisory.burnRate === null) {
    pace = modelFailure(provider) ?? "No current pace.";
  } else if (advisory.status === "at risk") {
    pace = `${advisory.burnRate.toFixed(1)}%/day so far this window, against a ${advisory.idealRate.toFixed(1)}%/day target.`;
  } else {
    pace = `${advisory.burnRate.toFixed(1)}%/day so far this window. Finishing it needs ${advisory.idealRate.toFixed(1)}%/day.`;
  }
  let decision: string;
  if (provider.exclusionReason) {
    decision = "Excluded before ranking.";
  } else if (recommendation && recommendation.use === provider.id && recommendation.reason) {
    decision = recommendation.reason;
  } else if (advisory?.status === "at risk") {
    decision = "Forecast to hit the cap before reset; flagged to ease off.";
  } else if (advisory?.urgency === "slow down") {
    decision = "Burning faster than the window; ease off.";
  } else if (advisory?.urgency === "on track") {
    decision = "Pace matches the window.";
  } else {
    decision = "Unused quota in this reset window.";
  }
  return { known, pace, decision };
}

function modelFailure(provider: ProviderView): string | null {
  const words = failureWords(provider.lastAttempt?.failureCategory ?? null);
  return words ? `No current pace. ${words}.` : null;
}

export function compactSnapshot(provider: ProviderView, asOfMs: number): Record<string, unknown> {
  const quota = provider.quota;
  const { elapsedPct } = barGeometry(provider, asOfMs);
  return {
    provider: provider.id,
    plan: quota?.plan ? quota.plan.split(" · ")[0] : null,
    usedPct: quota?.usedPct ?? null,
    elapsedPct: elapsedPct !== null ? Math.round(elapsedPct) : null,
    resetsAt: quota?.resetsAt ?? null,
    source: quota?.source ?? null,
    pacingStatus: pacingStatusToken(provider),
    reporting: provider.reporting,
  };
}

export function ProviderDrawer({
  provider,
  asOf,
  recommendation,
  onClose,
}: {
  provider: ProviderView | null;
  asOf: string;
  recommendation: RecommendationView | null;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    if (!provider) return;
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
      // The dialog container holds focus on open, so a reverse tab from it
      // would otherwise leave the drawer for the page behind.
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
  }, [provider, onClose]);

  const [copied, setCopied] = useState(false);

  if (!provider) return null;
  const model = drawerModel(provider);
  const titleId = "provider-drawer-title";
  const asOfMs = Date.parse(asOf);
  const updated = ageDuration(model.ageMs);
  const underline = resetUnderline(provider, asOfMs);
  const why = rankingCopy(provider, recommendation);
  const record = compactSnapshot(provider, asOfMs);
  const recordJson = JSON.stringify(record, null, 2);
  const planBits = [provider.quota?.plan, sourceLabel(provider.quota?.source)].filter(
    (b) => b && b !== "unknown"
  );
  const sub = planBits.join(" · ");

  return (
    <>
      <div
        data-testid="drawer-scrim"
        className="scrim is-open"
        aria-hidden="true"
        onClick={onClose}
      />
      <aside
        ref={dialogRef}
        tabIndex={-1}
        data-testid="provider-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="drawer is-open"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <span className="picon" style={providerTint(provider.id)}>
            <ProviderIcon id={provider.id} title={model.name} />
          </span>
          <div style={{ flex: 1 }}>
            <h2 id={titleId}>{model.name}</h2>
            <span className="sub">{providerSubtitle(provider) ?? sub}</span>
          </div>
          <button
            className="drawer-close"
            type="button"
            aria-label="Close provider details"
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

        {provider.description && (
          <p
            style={{
              margin: "0 var(--s4) var(--s3)",
              fontSize: "var(--t-2)",
              color: "var(--ink-soft)",
            }}
          >
            {provider.description}
          </p>
        )}

        <section className="dsec" aria-label="Current window">
          <h3>Current window</h3>
          <div className="pcard-topline">
            <Badge provider={provider} />
          </div>
          {provider.quota ? (
            <>
              <PaceBar provider={provider} asOf={asOf} />
              {underline && <div className="pcard-underline">{underline}</div>}
            </>
          ) : (
            <p className="cell-s">No readings yet.</p>
          )}
        </section>

        {model.sessionPct !== undefined && model.sessionPct > 0 && (
          <section className="dsec" aria-label="Session">
            <h3>Session</h3>
            <div className="pcard-topline">
              <span className="used">{model.sessionPct}% used</span>
            </div>
            <div className="track" role="img" aria-label={`${model.sessionPct} percent of session window used`}>
              <div
                className="fill"
                style={{
                  width: `${Math.min(100, Math.max(0, model.sessionPct))}%`,
                  background: "var(--fill-ontrack)",
                  ["--fill-edge" as string]: "var(--edge-ontrack)",
                }}
              />
            </div>
          </section>
        )}

        <section className="dsec" aria-label="Adapter and provenance">
          <h3>Adapter and provenance</h3>
          <dl className="dkv">
            <dt>Read by</dt>
            <dd>{sourceLabel(provider.quota?.source)}</dd>
            <dt>Credential</dt>
            <dd>{credentialLabel(provider)}</dd>
            <dt>Window</dt>
            <dd>
              {[
                provider.quota?.plan && provider.quota.plan !== "unknown" ? provider.quota.plan : null,
                resetStamp(provider) ? `resets ${resetStamp(provider)}` : null,
              ]
                .filter(Boolean)
                .join(" · ") || "—"}
            </dd>
            <dt>Pace basis</dt>
            <dd>{paceBasis(provider, asOfMs)}</dd>
            <dt>Last read</dt>
            <dd>
              {updated ? `${updated} ago` : "unknown"}
              {model.failureWords ? ` · ${model.failureWords}` : ""}
            </dd>
          </dl>
          <div className="draw-code-head">
            <span className="cell-s">Raw JSON snapshot:</span>
            <button
              className="btn btn-quiet btn-sm"
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(recordJson)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                  .catch(() => {});
              }}
            >
              {copied ? "Copied!" : "Copy JSON"}
            </button>
          </div>
          <pre className="draw-code">{recordJson}</pre>
        </section>

        <section className="dsec" aria-label="Ranking rationale">
          <h3>Ranking rationale</h3>
          <div className="why-block">
            <b>Known</b>
            <span>{why.known}</span>
          </div>
          <div className="why-block">
            <b>Pace</b>
            <span>{why.pace}</span>
          </div>
          <div className="why-block">
            <b>Decision</b>
            <span>{why.decision}</span>
          </div>
        </section>
      </aside>
    </>
  );
}

