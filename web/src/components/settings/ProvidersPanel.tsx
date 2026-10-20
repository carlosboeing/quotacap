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
  ["muse", "Muse Code"],
  ["opencode-go", "OpenCode Go"],
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

export function statusPillClass(status: SettingsStatus): string {
  if (status === "Ready") return "pill pill-ready";
  if (status === "Failed" || status === "Invalid") return "pill pill-danger";
  return "pill pill-warn";
}

export function ProvidersPanel({
  providers,
  refreshing,
  onSetProviderEnabled,
}: {
  providers: ProviderView[];
  refreshing: boolean;
  onSetProviderEnabled?: (id: string, enabled: boolean) => void;
}) {
  const listed = adapterProviders(providers);
  return (
    <div>
      <h3 className="settings-h3">Active Tool Connections</h3>

      <div className="settings-list">
        {listed.map((p) => {
          const status = providerStatus(p);
          return (
            <div key={p.id} className="settings-row">
              <div>
                <b className="settings-row-name">{connectionName(p.id)}</b>
                <span className="settings-row-source">{sourceLabel(p.quota?.source)}</span>
              </div>
              <div className="settings-row-actions">
                <span className={statusPillClass(status)}>{connectionBadge(p)}</span>
                {/* agy:3p shares the agy adapter and has no enablement of its own */}
                {onSetProviderEnabled && p.id !== "agy:3p" && (
                  <button
                    type="button"
                    className="btn btn-quiet btn-sm"
                    aria-label={`${p.enabled ? "Disable" : "Enable"} ${connectionName(p.id)}`}
                    onClick={() => onSetProviderEnabled(p.id, !p.enabled)}
                    disabled={refreshing}
                  >
                    {p.enabled ? "Disable" : "Enable"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
