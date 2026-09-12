import React from "react";
import type { ProviderView } from "../../state.js";
import { ageDuration } from "../../state.js";
import { sourceLabel } from "../ProviderDrawer.js";

/** Settings lists CLI adapters only. */
export function adapterProviders(providers: ProviderView[]): ProviderView[] {
  return providers.filter((p) => p.harness !== null);
}

const CONNECTION_NAMES = new Map<string, string>([
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["kimi", "Kimi Code"],
  ["grok", "Grok"],
  ["agy", "Antigravity"],
  ["agy:3p", "Antigravity 3P"],
]);

export function connectionName(id: string): string {
  return CONNECTION_NAMES.get(id) ?? id;
}

export function connectionBadge(provider: ProviderView): string {
  const status = providerStatus(provider);
  const age = ageDuration(provider.ageMs);
  return age ? `${status} · ${age} ago` : status;
}

export type SettingsStatus = "Ready" | "Stale" | "Failed" | "Invalid" | "Reset passed" | "Not reporting";

/** Short status from server exclusion and attempt fields. */
export function providerStatus(provider: ProviderView): SettingsStatus {
  switch (provider.exclusionReason) {
    case "stale":
      return "Stale";
    case "provider-failed":
      return "Failed";
    case "invalid":
      return "Invalid";
    case "reset-passed":
      return "Reset passed";
    case "not-reporting":
      return "Not reporting";
    case null:
      return provider.lastAttempt && !provider.lastAttempt.success ? "Failed" : "Ready";
  }
}

export function ProvidersPanel({
  providers,
  onRefresh,
  refreshing,
}: {
  providers: ProviderView[];
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const listed = adapterProviders(providers);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--s3)" }}>
        <h3 style={{ fontSize: "var(--t-3)", fontWeight: 700, margin: 0 }}>Active Tool Connections</h3>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={onRefresh}
          disabled={refreshing}
          style={{ fontSize: "var(--t-1)", padding: "4px 8px" }}
        >
          {refreshing ? "Polling…" : "Re-poll adapters"}
        </button>
      </div>

      <div
        style={{
          border: "1px solid var(--line)",
          borderRadius: "var(--r-md)",
          overflow: "hidden",
          background: "var(--surface)",
          marginBottom: "var(--s5)",
        }}
      >
        {listed.map((p, i) => {
          const status = providerStatus(p);
          const isReady = status === "Ready";
          return (
            <div
              key={p.id}
              style={{
                padding: "10px 14px",
                borderBottom: i < listed.length - 1 ? "1px solid var(--line)" : "none",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <b style={{ fontSize: "var(--t-3)" }}>{connectionName(p.id)}</b>
                <span style={{ display: "block", fontSize: "var(--t-1)", color: "var(--ink-soft)" }}>
                  {sourceLabel(p.quota?.source)}
                </span>
              </div>
              <span
                className={isReady ? "st-ready" : "st-todo"}
                style={{
                  fontSize: "var(--t-1)",
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: isReady ? "var(--good-soft)" : "var(--warn-soft)",
                  border: `1px solid ${isReady ? "var(--good)" : "var(--warn)"}`,
                  color: isReady ? "var(--good)" : "var(--warn)",
                  fontWeight: 600,
                }}
              >
                {connectionBadge(p)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

