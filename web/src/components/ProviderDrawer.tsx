import React, { useEffect, useRef } from "react";
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
      if (e.shiftKey && document.activeElement === first) {
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

  if (!provider) return null;
  const model = drawerModel(provider);
  const titleId = "provider-drawer-title";
  const updated = ageDuration(model.ageMs);

  return (
    <div
      data-testid="drawer-scrim"
      aria-hidden="false"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        zIndex: 40,
      }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        data-testid="provider-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(480px, 90vw)",
          background: "var(--surface)",
          color: "var(--ink)",
          borderLeft: "1px solid var(--line)",
          padding: 16,
          overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h2 id={titleId} style={{ font: "var(--t-4)", flexGrow: 1, margin: 0 }}>
            {model.name}
          </h2>
          <Badge provider={provider} />
          <button type="button" aria-label="Close provider details" onClick={onClose}>
            ✕
          </button>
        </div>

        {model.exclusionWords && (
          <p role="note" style={{ font: "var(--t-3)" }}>
            {model.exclusionWords}
          </p>
        )}

        <section aria-label="Pacing">
          <h3 style={{ font: "var(--t-2)" }}>Pacing</h3>
          {model.paceSource === "unknown" || model.burnRate === null ? (
            <p style={{ font: "var(--t-3)" }}>Measuring pace — no rate yet.</p>
          ) : (
            <dl style={{ font: "var(--t-2)" }}>
              <div>
                <dt>Burn rate</dt>
                <dd>
                  {model.burnRate.toFixed(1)}%/d ({model.paceLabel})
                </dd>
              </div>
              <div>
                <dt>Ideal rate</dt>
                <dd>{model.idealRate !== null ? `${model.idealRate.toFixed(1)}%/d` : "—"}</dd>
              </div>
              {model.daysToExhaust !== null && (
                <div>
                  <dt>Exhausts in</dt>
                  <dd>{model.daysToExhaust.toFixed(1)}d</dd>
                </div>
              )}
              {model.wastePct !== null && (
                <div>
                  <dt>Unused at this rate</dt>
                  <dd>
                    {Math.round(model.wastePct)}% in {model.daysLeft !== null ? model.daysLeft.toFixed(1) : "—"}d
                  </dd>
                </div>
              )}
            </dl>
          )}
          {model.daysLeft !== null && (
            <p style={{ font: "var(--t-2)" }}>
              {model.remaining !== null ? `${Math.round(model.remaining)}% remains · ` : ""}
              {model.daysLeft.toFixed(1)}d left
            </p>
          )}
        </section>

        <section aria-label="Window">
          <h3 style={{ font: "var(--t-2)" }}>Window</h3>
          <p style={{ font: "var(--t-2)" }}>
            {formatDateTime(model.periodStart)} → {formatDateTime(model.resetsAt)}
            {model.estimatedReset ? " (est.)" : ""}
          </p>
          {model.sessionPct !== undefined && (
            <p style={{ font: "var(--t-2)" }}>Session use {model.sessionPct}%</p>
          )}
        </section>

        <section aria-label="Provenance">
          <h3 style={{ font: "var(--t-2)" }}>Provenance</h3>
          <dl style={{ font: "var(--t-2)" }}>
            <div>
              <dt>Last success</dt>
              <dd>{model.lastSuccessAt ? formatDateTime(model.lastSuccessAt) : "never"}</dd>
            </div>
            <div>
              <dt>Reading age</dt>
              <dd>{updated ? `${updated} ago` : "unknown"}</dd>
            </div>
            {model.failureWords && (
              <div>
                <dt>Last attempt</dt>
                <dd>{model.failureWords}</dd>
              </div>
            )}
            {evidenceLabels(model.evidence).length > 0 && (
              <div>
                <dt>Evidence</dt>
                <dd>{evidenceLabels(model.evidence).join(" · ")}</dd>
              </div>
            )}
          </dl>
        </section>
      </div>
    </div>
  );
}
