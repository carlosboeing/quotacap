import React from "react";
import type { ProviderView } from "../state.js";
import { ageDuration } from "../state.js";
import { displayName } from "../names.js";
import { failureWords } from "./ProviderDrawer.js";

export interface Repair {
  text: string;
}

/**
 * Repair routing per excluded provider. Auth failures point at signing into
 * the provider CLI (QuotaCap never handles those credentials); every other
 * exclusion points at a re-poll. Service start/install is covered by the
 * service-unavailable panel when the daemon itself is down.
 */
export function repairFor(provider: ProviderView): Repair {
  const name = displayName(provider.id);
  if (provider.lastAttempt?.failureCategory === "auth") {
    return {
      text: `Sign in to the ${name} CLI, then re-poll. QuotaCap never handles those credentials.`,
    };
  }
  switch (provider.exclusionReason) {
    case "stale":
      return { text: "Poll again to refresh this reading." };
    case "reset-passed":
      return { text: "Poll again to capture the new window." };
    case "invalid":
      return { text: `Check the ${name} CLI output, then re-poll.` };
    case "provider-failed": {
      const failure = failureWords(provider.lastAttempt?.failureCategory ?? null);
      return { text: `${failure ?? "Provider failed"} — check the ${name} CLI, then re-poll.` };
    }
    case "not-reporting":
      return { text: "No readings yet — run a poll." };
    case null:
      return { text: "Poll again to refresh this reading." };
  }
}

function bannerVerb(provider: ProviderView): string {
  switch (provider.exclusionReason) {
    case "stale":
      return "stopped reporting";
    case "reset-passed":
      return "reset passed";
    case "invalid":
      return "sent an invalid reading";
    case "provider-failed":
      return "failed";
    case "not-reporting":
      return "isn't reporting yet";
    case null:
      return "needs attention";
  }
}

export function FaultBanner({
  providers,
  onRepoll,
  repolling,
}: {
  providers: ProviderView[];
  onRepoll: () => void;
  repolling: boolean;
}) {
  const faulted = providers.filter((p) => p.enabled && p.exclusionReason !== null);
  if (faulted.length === 0) return null;
  return (
    <div>
      {faulted.map((p) => {
        const age = ageDuration(p.ageMs);
        const repair = repairFor(p);
        return (
          <div
            key={p.id}
            data-testid="fault-banner"
            role="alert"
            style={{
              border: "1px solid var(--danger)",
              borderRadius: 8,
              padding: 8,
              marginBottom: 8,
              font: "var(--t-3)",
            }}
          >
            <strong>{displayName(p.id)}</strong> {bannerVerb(p)}. {age ? `Last read ${age} ago; ` : ""}
            excluded from ranking. {repair.text}{" "}
            <button type="button" onClick={onRepoll} disabled={repolling}>
              {repolling ? "Polling…" : "Re-poll"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
