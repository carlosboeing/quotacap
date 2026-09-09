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

function pillColor(pill: PillState): string {
  switch (pill) {
    case "live":
      return "var(--accent)";
    case "polling":
      return "var(--warn)";
    case "unreachable":
      return "var(--danger)";
    case "not-ready":
      return "var(--ahead)";
  }
}

function servingHost(): string {
  try {
    return window.location.host || "127.0.0.1:8787";
  } catch {
    return "127.0.0.1:8787";
  }
}

function pillText(pill: PillState, runtime: RuntimeView): string {
  switch (pill) {
    case "live":
      return `Daemon active ${servingHost()}`;
    case "polling":
      return runtime.polling === "cooldown" ? "Cooling down" : "Polling";
    case "unreachable":
      return "Daemon unreachable";
    case "not-ready":
      return runtime.version === "" ? "Version unknown" : "Daemon not ready";
  }
}

export function Header({
  runtime,
  refreshing,
  onRefresh,
  onSettings,
}: {
  runtime: RuntimeView | null;
  refreshing: boolean;
  onRefresh: () => void;
  onSettings: () => void;
}) {
  const pill = runtime ? pillFor(runtime) : null;
  return (
    <header
      style={{
        display: "flex",
        gap: 12,
        alignItems: "center",
        padding: "12px 0",
        flexWrap: "wrap",
      }}
    >
      <div style={{ font: "var(--t-5)", flexGrow: 1 }}>QuotaCap</div>
      {runtime && pill ? (
        <span
          data-testid="pill"
          data-state={pill}
          role="status"
          title={`available: ${runtime.available}; ready: ${runtime.ready}; polling: ${runtime.polling}; version: ${runtime.version}`}
          style={{ font: "var(--t-2)", color: pillColor(pill), whiteSpace: "nowrap" }}
        >
          <span aria-hidden="true">● </span>
          {pillText(pill, runtime)}
        </span>
      ) : (
        <span data-testid="pill" data-state="connecting" role="status" style={{ font: "var(--t-2)" }}>
          Connecting…
        </span>
      )}
      <ThemeToggle />
      <button data-testid="refresh-button" type="button" onClick={onRefresh} disabled={refreshing}>
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
      <button data-testid="settings-button" type="button" onClick={onSettings}>
        Settings
      </button>
    </header>
  );
}
