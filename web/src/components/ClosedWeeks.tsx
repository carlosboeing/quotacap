import React from "react";
import { format } from "date-fns";
import type { WindowCloseView } from "../state.js";

const STALE_EARLY_MS = 15 * 60 * 1000;

export function lastClose(provider: { lastCloses?: WindowCloseView[] }): WindowCloseView | null {
  const closes = provider.lastCloses;
  return Array.isArray(closes) && closes.length > 0 ? closes[0] : null;
}

export function closeDateLabel(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return null;
  return format(new Date(ms), "d MMM");
}

export function closeIsStale(c: WindowCloseView): boolean {
  if (!c.resetsAt) return true;
  const resetMs = Date.parse(c.resetsAt);
  const sampledMs = Date.parse(c.sampledAt);
  if (!Number.isFinite(resetMs) || !Number.isFinite(sampledMs)) return true;
  return resetMs - sampledMs > STALE_EARLY_MS;
}

export function closeSampleStamp(sampledAt: string): string | null {
  const ms = Date.parse(sampledAt);
  if (!Number.isFinite(ms)) return null;
  return format(new Date(ms), "EEE d MMM H:mm");
}

export function closeResetStamp(resetsAt: string): string | null {
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return null;
  return format(new Date(ms), "d MMM HH:mm");
}

type EarlyUnit = "s" | "m" | "h" | "d";

/** One floored duration for both the compact cell line and the strip note. */
function earlyParts(ms: number): { n: number; unit: EarlyUnit } {
  if (ms < 60_000) return { n: Math.max(1, Math.floor(ms / 1000)), unit: "s" };
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return { n: minutes, unit: "m" };
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return { n: hours, unit: "h" };
  return { n: Math.floor(hours / 24), unit: "d" };
}

const EARLY_UNIT_WORDS: Record<EarlyUnit, string> = {
  s: "second",
  m: "minute",
  h: "hour",
  d: "day",
};

function earlyCompact(ms: number): string {
  const { n, unit } = earlyParts(ms);
  return `${n}${unit}`;
}

function earlyWords(ms: number): string {
  const { n, unit } = earlyParts(ms);
  return `${n} ${EARLY_UNIT_WORDS[unit]}${n === 1 ? "" : "s"}`;
}

/** Four-cell strip of closed weekly windows, oldest left. Fill is used at
 * close, the hatch is the stored leftover. One cell per real close, never a
 * placeholder. Stale samples name their reading on the cell and under the
 * strip. */
export function ClosedWeeks({ closes }: { closes: WindowCloseView[] }) {
  if (!Array.isArray(closes) || closes.length === 0) return null;
  const cells = [...closes].reverse();
  const labels = cells.map((c) => closeDateLabel(c.resetsAt));
  return (
    <section className="dsec" aria-label="Closed weeks">
      <h3>Closed weeks</h3>
      <div className="weeks" data-testid="closed-weeks">
        {cells.map((c, i) => {
          const used = Math.min(100, Math.max(0, c.usedPct));
          const leftover = Math.min(100, Math.max(0, c.leftoverPct));
          const stale = closeIsStale(c);
          const sampled = closeSampleStamp(c.sampledAt);
          const reset = c.resetsAt ? closeResetStamp(c.resetsAt) : null;
          const earlyMs = c.resetsAt ? Date.parse(c.resetsAt) - Date.parse(c.sampledAt) : NaN;
          const est = c.resetsAtEstimated ? " (est.)" : "";
          const title = [
            `${c.usedPct}% used`,
            `${c.leftoverPct}% leftover`,
            reset ? `reset ${reset}${est}` : "reset unknown",
            stale && sampled ? `last reading ${sampled}` : null,
          ]
            .filter(Boolean)
            .join(", ");
          return (
            <div className="week" key={`${c.detectedAt}-${c.sampledAt}`} title={title}>
              <div className="track" role="img" aria-label={title}>
                <div className="fill" style={{ width: `${used}%` }} />
                {leftover > 0 && (
                  <div className="band band-waste" style={{ left: `${used}%`, width: `${leftover}%` }} />
                )}
              </div>
              <div className="lab">
                <span>{labels[i] ?? "date unknown"}</span>
                <b>
                  {c.leftoverPct}% leftover{est}
                </b>
                {stale && Number.isFinite(earlyMs) && earlyMs > 0 && (
                  <span className="stale-note">read {earlyCompact(earlyMs)} early</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {cells.map((c, i) => {
        const resetMs = c.resetsAt ? Date.parse(c.resetsAt) : NaN;
        const sampledMs = Date.parse(c.sampledAt);
        const sampled = closeSampleStamp(c.sampledAt);
        if (
          !closeIsStale(c) ||
          !sampled ||
          !Number.isFinite(resetMs) ||
          !Number.isFinite(sampledMs) ||
          resetMs <= sampledMs
        ) {
          return null;
        }
        return (
          <p className="cell-s stale-note" key={`note-${c.detectedAt}-${c.sampledAt}`}>
            {labels[i] ?? "Date unknown"} leftover is from the {sampled} reading, {earlyWords(resetMs - sampledMs)}{" "}
            before that reset.
          </p>
        );
      })}
    </section>
  );
}
