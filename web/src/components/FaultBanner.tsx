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
            className="alert"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.3"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M12 8v5" />
              <path d="M12 16.5v.01" />
              <circle cx="12" cy="12" r="9" />
            </svg>
            <span>
              <strong>
                {displayName(p.id)} {bannerVerb(p)}.
              </strong>{" "}
              {age ? `Last read ${age} ago; ` : ""}
              excluded from ranking. {repair.text}
            </span>
            <button
              type="button"
              className="linkbtn"
              onClick={onRepoll}
              disabled={repolling}
              style={{ flex: "none", marginLeft: "auto" }}
            >
              {repolling ? "Polling…" : `Check ${displayName(p.id)}`}
            </button>
          </div>
        );
      })}
    </div>
  );
}

