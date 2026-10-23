import React from "react";
import type { ProviderView } from "../state.js";
import { rateLimitWaits } from "../../../src/format/rate-limit-wait.js";

/** Full short window, with the date and time it clears. Quiet when none is full. */
export function RateLimitNote({ provider, asOf }: { provider: ProviderView; asOf: string }) {
  const asOfMs = Date.parse(asOf);
  const now = Number.isFinite(asOfMs) ? new Date(asOfMs) : new Date();
  const waits = rateLimitWaits(provider, now);
  if (waits.length === 0) return null;
  return (
    <p className="rate-wait" data-testid={`rate-wait-${provider.id}`}>
      {waits.map((w) => (
        <span key={w.window}>{w.text}</span>
      ))}
    </p>
  );
}
