import React, { useEffect, useRef, useState } from "react";

import type {
  ExclusionReason,
  FailureCategory,
  PaceSource,
  ProviderView,
} from "../state.js";
import { ageDuration } from "../state.js";
import { displayName } from "../names.js";
import { Badge, evidenceLabels, paceBadge, type PaceBadge } from "./PaceBar.js";

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
    name: displayName(provider.id),
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

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ProviderDrawer({
  provider,
  onClose,
}: {
  provider: ProviderView | null;
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
  const updated = ageDuration(model.ageMs);

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
          <span
            className="picon"
            style={{
              background: `color-mix(in oklch, var(--p-${provider.id.split(":")[0]}, var(--accent)) 16%, transparent)`,
              color: `var(--p-${provider.id.split(":")[0]}, var(--accent))`,
            }}
          >
            {model.name.charAt(0)}
          </span>
          <div style={{ flex: 1 }}>
            <h2 id={titleId}>{model.name}</h2>
            <span className="sub" style={{ fontSize: "var(--t-2)", color: "var(--ink-soft)" }}>
              {provider.id}
            </span>
          </div>
          <Badge provider={provider} />
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

        {model.exclusionWords && (
          <div className="alert" role="note" style={{ margin: "var(--s4) var(--s5) 0" }}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{model.exclusionWords}</span>
          </div>
        )}

        <section className="dsec" aria-label="Pacing">
          <h3>Pacing</h3>
          {model.paceSource === "unknown" || model.burnRate === null ? (
            <p style={{ font: "var(--t-3)", color: "var(--ink-soft)", margin: 0 }}>
              Measuring pace — no rate yet.
            </p>
          ) : (
            <dl className="dkv">
              <dt>Burn rate</dt>
              <dd>
                {model.burnRate.toFixed(1)}%/d {model.paceLabel ? `(${model.paceLabel})` : ""}
              </dd>
              <dt>Ideal rate</dt>
              <dd>{model.idealRate !== null ? `${model.idealRate.toFixed(1)}%/d` : "—"}</dd>
              {model.daysToExhaust !== null && (
                <>
                  <dt>Exhausts in</dt>
                  <dd>{model.daysToExhaust.toFixed(1)}d</dd>
                </>
              )}
              {model.wastePct !== null && (
                <>
                  <dt>Unused at this rate</dt>
                  <dd>
                    {Math.round(model.wastePct)}% in {model.daysLeft !== null ? model.daysLeft.toFixed(1) : "—"}d
                  </dd>
                </>
              )}
            </dl>
          )}
          {model.daysLeft !== null && (
            <p style={{ font: "var(--t-2)", color: "var(--ink-soft)", marginTop: "var(--s3)", marginBottom: 0 }}>
              {model.remaining !== null ? `${Math.round(model.remaining)}% remains · ` : ""}
              {model.daysLeft.toFixed(1)}d left
            </p>
          )}
        </section>

        <section className="dsec" aria-label="Window">
          <h3>Window</h3>
          <p style={{ font: "var(--t-2)", margin: "0 0 var(--s2)" }}>
            {formatDateTime(model.periodStart)} → {formatDateTime(model.resetsAt)}
            {model.estimatedReset ? " (est.)" : ""}
          </p>
          {model.sessionPct !== undefined && (
            <div style={{ marginTop: "var(--s2)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--t-2)", marginBottom: 4 }}>
                <span style={{ fontWeight: 600 }}>Session use</span>
                <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{model.sessionPct}%</span>
              </div>
              <div className="track" role="img" aria-label={`${model.sessionPct} percent of session window used`}>
                <div
                  className="fill"
                  style={{
                    width: `${Math.min(100, Math.max(0, model.sessionPct))}%`,
                    background: "var(--fill-ontrack)",
                  }}
                />
              </div>
            </div>
          )}
        </section>

        <section className="dsec" aria-label="Provenance">
          <h3>Provenance</h3>
          <dl className="dkv">
            <dt>Last success</dt>
            <dd>{model.lastSuccessAt ? formatDateTime(model.lastSuccessAt) : "never"}</dd>
            <dt>Reading age</dt>
            <dd>{updated ? `${updated} ago` : "unknown"}</dd>
            {model.failureWords && (
              <>
                <dt>Last attempt</dt>
                <dd style={{ color: "var(--danger)" }}>{model.failureWords}</dd>
              </>
            )}
            {evidenceLabels(model.evidence).length > 0 && (
              <>
                <dt>Evidence</dt>
                <dd>{evidenceLabels(model.evidence).join(" · ")}</dd>
              </>
            )}
          </dl>
          <div className="draw-code-head">
            <span style={{ fontSize: "var(--t-1)", color: "var(--ink-soft)" }}>Raw JSON snapshot:</span>
            <button
              className="btn btn-quiet btn-sm"
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(JSON.stringify(provider, null, 2));
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied!" : "Copy JSON"}
            </button>
          </div>
          <pre className="draw-code">{JSON.stringify(provider, null, 2)}</pre>
        </section>
      </aside>
    </>
  );
}

