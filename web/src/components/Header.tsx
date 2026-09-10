import React from "react";
import type { RuntimeView } from "../state.js";
import { ThemeToggle } from "../Theme.js";

export type PillState = "live" | "polling" | "unreachable" | "not-ready";

/**
 * Header pill from runtime fields. Unreachable is red, polling/cooldown is
 * amber, ready plus idle is green. Not-ready and unknown-version surface as
 * their own explicit state, never as green.
 */
export function pillFor(runtime: {
  available: boolean;
  ready: boolean;
  polling: RuntimeView["polling"];
  version?: string;
}): PillState {
  if (!runtime.available) return "unreachable";
  if (runtime.polling === "in-progress" || runtime.polling === "cooldown") return "polling";
  if (!runtime.ready) return "not-ready";
  if (runtime.version === "") return "not-ready";
  return "live";
}

function servingHost(): string {
  try {
    return window.location.host || "127.0.0.1:8787";
  } catch {
    return "127.0.0.1:8787";
  }
}

function pillText(pill: PillState, runtime: RuntimeView | null): string {
  switch (pill) {
    case "live":
      return "daemon live";
    case "polling":
      return runtime?.polling === "cooldown" ? "Cooling down" : "Polling";
    case "unreachable":
      return "Daemon unreachable";
    case "not-ready":
      return runtime?.version === "" ? "Version unknown" : "Daemon not ready";
  }
}

export function Header({
  runtime,
  refreshing,
  onRefresh,
  onSettings,
  unreachable = false,
}: {
  runtime: RuntimeView | null;
  refreshing: boolean;
  onRefresh: () => void;
  onSettings: () => void;
  /** The last request to the daemon failed at the network level. */
  unreachable?: boolean;
}) {
  // A failed request outranks the snapshot: the stored runtime fields describe
  // the last answer, not the current one.
  const pill = unreachable ? "unreachable" : runtime ? pillFor(runtime) : null;
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <span className="brand">
          <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 16.5a8 8 0 0 1 16 0" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
            <path d="M12 16.5l4.8-4.6" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
          </svg>
          QuotaCap
        </span>
        <div className="topbar-end">
          {pill ? (
            <span
              data-testid="pill"
              data-state={pill}
              role="status"
              className="daemon"
              title={
                runtime
                  ? `available: ${runtime.available}; ready: ${runtime.ready}; polling: ${runtime.polling}; version: ${runtime.version}`
                  : "no snapshot yet"
              }
            >
              <span className={`daemon-dot is-${pill}`} aria-hidden="true" />
              <span className="daemon-t">{pillText(pill, runtime)}</span>
              {pill === "live" && <code className="daemon-addr"> · {servingHost()}</code>}
            </span>
          ) : (
            <span data-testid="pill" data-state="connecting" role="status" className="daemon">
              <span className="daemon-dot is-polling" aria-hidden="true" />
              <span className="daemon-t">Connecting…</span>
            </span>
          )}
          <div className="topbar-actions">
            <ThemeToggle />
            <button
              data-testid="refresh-button"
              className="btn btn-quiet"
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              title="Force refresh now"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <path d="M20 12a8 8 0 1 1-2.5-5.8" />
                <path d="M20 4v4h-4" />
              </svg>
              <span className="btn-label">{refreshing ? "Refreshing…" : "Refresh"}</span>
            </button>
            <button
              data-testid="settings-button"
              className="btn btn-quiet"
              type="button"
              onClick={onSettings}
              title="Open Settings"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span className="btn-label">Settings</span>
            </button>

          </div>
        </div>
      </div>
    </header>
  );
}
