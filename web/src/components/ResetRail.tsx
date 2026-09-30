import React, { useEffect, useRef, useState } from "react";
import type { ProviderView } from "../state.js";
import { paceBadge, resetClock, resetCountdown, timeLeft } from "./PaceBar.js";

export const RAIL_DAYS = 7;
const RAIL_MS = RAIL_DAYS * 24 * 60 * 60 * 1000;
/** Pins within this span of rail group into one collision window (grouped mode). */
const COLLISION_PCT = 3;
/** Pins per window past which they group into a cluster pin (grouped mode). */
const WINDOW_CAPACITY = 2;
/** Stem height; every pin sits at tier 0, so the rail never grows. */
export const STEM_PX = 14;
/** Layout width before the rail measures itself (dashboard content max). */
const RAIL_REF_PX = 1072;
/** Gap kept between dodged pills. */
const DODGE_GAP_PX = 6;
/** Computed overlap tolerated before pins dodge; pills may touch slightly. */
const GROUP_OVERLAP_TOL_PX = 10;
/** Widest one dodge group may spread; past this pills shingle with overlap. */
const MAX_GROUP_SPREAD_PX = 160;

export interface RailRow {
  id: string;
  /** Pill text, used to estimate the width for dodge packing. */
  label: string;
  resetsAt: string | null;
  estimated?: boolean;
}

export type RailBand = "above" | "below";

export interface PlacedPin extends RailRow {
  positionPct: number;
  band: RailBand;
  /** Sideways pill offset in px; the dot stays on the time coordinate. */
  offsetPx: number;
}

export interface PinCluster {
  ids: string[];
  label: string;
  positionPct: number;
  band: RailBand;
  /** Sideways pill offset in px; the dot stays on the time coordinate. */
  offsetPx: number;
}

export interface PinPlacement {
  placed: PlacedPin[];
  clusters: PinCluster[];
  overflow: RailRow[];
  invalid: RailRow[];
}

/** Half the pill width for a display name: 16ch cap, ~7px per char + chrome. */
export function pillHalfWidth(label: string): number {
  return (Math.min(label.length, 16) * 7 + 30) / 2;
}

/** Half the timestamp width: tabular mono, ~6.6px per char + padding. */
export function stampHalfWidth(text: string): number {
  return (text.length * 6.6 + 12) / 2;
}

function pinHalfWidth(pin: Pick<PlacedPin, "label" | "resetsAt" | "estimated">): number {
  // Candidates reaching layout always parsed, but the row type allows null.
  const clock = pin.resetsAt === null ? "" : (resetClock(pin.resetsAt) ?? "");
  const stamp = `${clock}${pin.estimated ? " (est.)" : ""}`;
  return Math.max(pillHalfWidth(pin.label), stampHalfWidth(stamp));
}

export type RailMode = "separate" | "grouped";

export const RAIL_MODE_KEY = "quotacap-rail-mode";

export function storedRailMode(): RailMode {
  try {
    const v = typeof localStorage === "undefined" ? null : localStorage.getItem(RAIL_MODE_KEY);
    return v === "grouped" ? "grouped" : "separate";
  } catch {
    return "separate";
  }
}

function persistRailMode(mode: RailMode): void {
  try {
    localStorage.setItem(RAIL_MODE_KEY, mode);
  } catch {
    // Private mode or non-DOM: the choice simply does not persist.
  }
}

/**
 * Place reset pins proportionally over the next 7 days from `asOf`.
 * Same-band pills that would overlap dodge sideways by pill width (earlier
 * left, later right); crowds past the spread cap shingle with small overlap
 * instead, resolved by hover. Dots stay on the time coordinate and the rail
 * stays flat. Resets beyond the rail overflow; invalid rows are reported;
 * reset-passed rows place no pin (the ledger shows "awaiting fresh window"
 * for them). Grouped mode collapses crowded windows into cluster pins.
 */
export function placePins(
  rows: RailRow[],
  asOf: Date,
  opts?: { grouped?: boolean; railWidthPx?: number }
): PinPlacement {
  const asOfMs = asOf.getTime();
  const placed: PlacedPin[] = [];
  const clusters: PinCluster[] = [];
  const overflow: RailRow[] = [];
  const invalid: RailRow[] = [];

  const candidates: Array<{ row: RailRow; resetMs: number; positionPct: number }> = [];
  for (const row of rows) {
    const resetMs = row.resetsAt === null ? NaN : Date.parse(row.resetsAt);
    if (!Number.isFinite(resetMs)) {
      invalid.push(row);
      continue;
    }
    if (resetMs <= asOfMs) continue; // reset passed: no pin on the future rail
    if (resetMs - asOfMs > RAIL_MS) {
      overflow.push(row);
      continue;
    }
    candidates.push({ row, resetMs, positionPct: ((resetMs - asOfMs) / RAIL_MS) * 100 });
  }
  candidates.sort((a, b) => a.resetMs - b.resetMs);

  // Group adjacent candidates into collision windows.
  const windows: typeof candidates[] = [];
  for (const c of candidates) {
    const last = windows[windows.length - 1];
    if (last && c.positionPct - last[0].positionPct < COLLISION_PCT) {
      last.push(c);
    } else {
      windows.push([c]);
    }
  }

  type Item =
    | { kind: "pin"; pin: PlacedPin }
    | { kind: "cluster"; cluster: PinCluster };
  const items: Item[] = [];
  for (const window of windows) {
    if (opts?.grouped && window.length > WINDOW_CAPACITY) {
      const positionPct = window.reduce((sum, c) => sum + c.positionPct, 0) / window.length;
      const ids = window.map((c) => c.row.id);
      items.push({
        kind: "cluster",
        cluster: { ids, label: `${ids.length} resets`, positionPct, band: "above", offsetPx: 0 },
      });
    } else {
      for (const c of window) {
        items.push({
          kind: "pin",
          pin: { ...c.row, positionPct: c.positionPct, band: "above", offsetPx: 0 },
        });
      }
    }
  }
  items.sort((a, b) => {
    const pa = a.kind === "pin" ? a.pin.positionPct : a.cluster.positionPct;
    const pb = b.kind === "pin" ? b.pin.positionPct : b.cluster.positionPct;
    return pa - pb;
  });

  // Alternate above/below bands so time-adjacent pins never share a side.
  items.forEach((item, index) => {
    const target = item.kind === "pin" ? item.pin : item.cluster;
    target.band = index % 2 === 0 ? "above" : "below";
  });

  const width = opts?.railWidthPx && opts.railWidthPx > 0 ? opts.railWidthPx : RAIL_REF_PX;
  const cap = Math.min(MAX_GROUP_SPREAD_PX, width * 0.3);
  for (const band of ["above", "below"] as const) {
    const lane = items
      .filter((item) => (item.kind === "pin" ? item.pin.band : item.cluster.band) === band)
      .map((item) => {
        const target = item.kind === "pin" ? item.pin : item.cluster;
        return {
          target,
          x: (target.positionPct / 100) * width,
          half: item.kind === "pin" ? pinHalfWidth(item.pin) : pillHalfWidth(item.cluster.label),
        };
      });
    // Chain natural extents into dodge groups.
    const groups: typeof lane[] = [];
    let group: typeof lane = [];
    let edge = -Infinity;
    const flush = () => {
      if (group.length > 0) groups.push(group);
      group = [];
      edge = -Infinity;
    };
    for (const slot of lane) {
      if (slot.x - slot.half > edge - GROUP_OVERLAP_TOL_PX) flush();
      group.push(slot);
      edge = Math.max(edge, slot.x + slot.half);
    }
    flush();
    for (const g of groups) {
      if (g.length === 1) continue; // offsetPx stays 0
      const mid = (g[0].x + g[g.length - 1].x) / 2;
      const totalW = g.reduce((sum, s) => sum + s.half * 2, 0) + DODGE_GAP_PX * (g.length - 1);
      let cursor = mid - totalW / 2;
      let centers = g.map((s) => {
        const center = cursor + s.half;
        cursor += s.half * 2 + DODGE_GAP_PX;
        return center;
      });
      const boxSpan = centers[centers.length - 1] + g[g.length - 1].half - (centers[0] - g[0].half);
      if (boxSpan > cap) centers = centers.map((c) => mid + ((c - mid) * cap) / boxSpan);
      const shift =
        centers[0] - g[0].half < 0
          ? -(centers[0] - g[0].half)
          : centers[centers.length - 1] + g[g.length - 1].half > width
            ? width - (centers[centers.length - 1] + g[g.length - 1].half)
            : 0;
      g.forEach((s, i) => {
        s.target.offsetPx = centers[i] + shift - s.x;
      });
    }
    // Singletons near the edges shift just enough to stay on the rail; the
    // diagonal stem reconnects the pill to its dot. Groups already clamp.
    for (const s of lane) {
      if (s.target.offsetPx !== 0) continue;
      const left = s.x - s.half;
      const right = s.x + s.half;
      if (left < 0) s.target.offsetPx = -left;
      else if (right > width) s.target.offsetPx = width - right;
    }
  }

  for (const item of items) {
    if (item.kind === "pin") placed.push(item.pin);
    else clusters.push(item.cluster);
  }
  return { placed, clusters, overflow, invalid };
}



function ClusterPopover({
  cluster,
  providers,
  asOfMs,
  onSelect,
  onClose,
}: {
  cluster: PinCluster;
  providers: Map<string, ProviderView>;
  asOfMs: number;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-testid="cluster-popover"
      role="dialog"
      aria-label={`${cluster.ids.length} resets at the same time`}
      className="cluster-popover"
      style={{
        left: `${cluster.positionPct}%`,
        transform: `translateX(-${cluster.positionPct}%)`,
        top: cluster.band === "above" ? "15%" : "55%",
      }}
    >
      <h4>{cluster.ids.length} concurrent resets</h4>
      <ul>
        {cluster.ids.map((id) => {
          const provider = providers.get(id);
          const name = provider?.displayName ?? id;
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => {
                  onSelect(id);
                  onClose();
                }}
              >
                <b>{name}</b>
                <span>
                  {provider?.quota ? `${provider.quota.weeklyPct}% · ` : ""}
                  {provider ? resetCountdown(provider, asOfMs) : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="btn btn-sm btn-quiet"
        style={{ marginTop: "var(--s2)", width: "100%" }}
        onClick={onClose}
      >
        Close
      </button>
    </div>
  );
}

function tzAbbrev(): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

function pinPace(provider: ProviderView | undefined): { cls: string; color: string } {
  if (!provider) return { cls: "pace-out", color: "var(--ink-soft)" };
  switch (paceBadge(provider)) {
    case "Behind pace":
      return { cls: "pace-behind", color: "var(--warn)" };
    case "On track":
      return { cls: "pace-ontrack", color: "var(--good)" };
    case "Ahead of pace":
      return { cls: "pace-ahead", color: "var(--ahead)" };
    case "Watch":
      return { cls: "pace-watch", color: "var(--watch)" };
    case "Monthly exhausted":
    case "Cap risk":
      return { cls: "pace-cap", color: "var(--danger)" };
    default:
      return { cls: "pace-out", color: "var(--ink-soft)" };
  }
}

function pinWhen(resetsAt: string): string {
  return resetClock(resetsAt) ?? "";
}

function dayLabels(asOfMs: number): string[] {
  return Array.from({ length: RAIL_DAYS }, (_, i) => {
    const d = new Date(asOfMs + i * 24 * 60 * 60 * 1000);
    const weekday = d.toLocaleDateString(undefined, { weekday: "short" });
    const day = d.toLocaleDateString(undefined, { day: "numeric" });
    return `${weekday} ${day}`;
  });
}

/**
 * Stem from the dot to the pill: vertical when centered, a short diagonal
 * when the pill dodged sideways. The over-tall layout box is pulled back
 * with a negative margin so the pill meets the stem's visual end.
 */
function PinStem({ band, offsetPx }: { band: RailBand; offsetPx: number }) {
  if (offsetPx === 0) return <span className="pin-stem" />;
  const dx = Math.abs(offsetPx);
  const len = Math.sqrt(dx * dx + STEM_PX * STEM_PX);
  const angle = (Math.atan2(dx, STEM_PX) * 180) / Math.PI;
  const deg = band === "above" ? Math.sign(offsetPx) * angle : -Math.sign(offsetPx) * angle;
  const pull = len - STEM_PX;
  const style: React.CSSProperties =
    band === "above"
      ? { height: len, marginTop: -pull, transform: `rotate(${deg}deg)` }
      : { height: len, marginBottom: -pull, transform: `rotate(${deg}deg)` };
  return <span className="pin-stem" style={style} />;
}

export function ResetRail({
  providers,
  asOf,
  onSelectProvider,
  initialMode,
}: {
  providers: ProviderView[];
  asOf: string;
  onSelectProvider: (id: string) => void;
  initialMode?: RailMode;
}) {
  const [openCluster, setOpenCluster] = useState<number | null>(null);
  const [mode, setMode] = useState<RailMode>(() => initialMode ?? storedRailMode());
  const [railWidth, setRailWidth] = useState<number>(RAIL_REF_PX);
  const railRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = railRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setRailWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const asOfMs = Date.parse(asOf);
  const byId = new Map(providers.map((p) => [p.id, p]));
  const rows: RailRow[] = providers
    .filter((p) => p.enabled && p.quota)
    .map((p) => ({
      id: p.id,
      label: p.displayName ?? p.id,
      resetsAt: p.quota!.resetsAt,
      estimated: !!p.quota!.resetsAtEstimated,
    }));
  const placement = placePins(rows, new Date(asOfMs), { grouped: mode === "grouped", railWidthPx: railWidth });
  const labels = dayLabels(asOfMs);
  const setModePersist = (next: RailMode) => {
    setOpenCluster(null);
    setMode(next);
    persistRailMode(next);
  };

  return (
    <section aria-label="Upcoming resets">
      <div className="section-head">
        <h2 id="resets-h">Upcoming resets</h2>
        <div className="section-head-controls">
          <span className="note">
            Next 7 days · hover pin for usage · click for details · {tzAbbrev()}
            {placement.overflow.length > 0 && (
              <span
                data-testid="rail-overflow"
                title={placement.overflow.map((o) => byId.get(o.id)?.displayName ?? o.id).join(", ")}
                style={{ marginLeft: 8, fontWeight: 600, color: "var(--ahead)" }}
              >
                +{placement.overflow.length} beyond rail
              </span>
            )}
          </span>
          <div data-testid="rail-mode" role="group" aria-label="Reset pin grouping" className="seg">
            <button type="button" aria-pressed={mode === "separate"} onClick={() => setModePersist("separate")}>
              Separate
            </button>
            <button type="button" aria-pressed={mode === "grouped"} onClick={() => setModePersist("grouped")}>
              Grouped
            </button>
          </div>
        </div>
      </div>

      <div
        data-testid="rail"
        className="rail-scroller"
        tabIndex={0}
        role="region"
        aria-label={`Upcoming resets over the next ${RAIL_DAYS} days`}
      >
        <div className="rail" ref={railRef}>
          <div className="rail-grid" aria-hidden="true">
            {Array.from({ length: RAIL_DAYS }, (_, i) => (
              <span key={i} />
            ))}
          </div>
          <div className="rail-axis" aria-hidden="true" />
          <div className="rail-now" aria-hidden="true" />
          <span className="rail-nowlabel" aria-hidden="true">
            Now
          </span>

          {placement.placed.map((pin) => {
            const provider = byId.get(pin.id);
            const when = provider?.quota ? pinWhen(provider.quota.resetsAt) : provider ? resetCountdown(provider, asOfMs) : "";
            const pace = provider ? paceBadge(provider) : "";
            const left = provider?.quota ? timeLeft(provider.quota.resetsAt, asOfMs) : null;
            const name = provider?.displayName ?? pin.id;
            const { cls: paceCls, color: paceColor } = pinPace(provider);
            const alignClass = pin.positionPct < 12 ? "pin-start" : pin.positionPct > 88 ? "pin-end" : "";
            const pinBorder = {
              ["--pin-border" as string]: `color-mix(in oklch, ${paceColor} 45%, var(--line))`,
            };
            const dodgeX = pin.offsetPx === 0 ? undefined : { translate: `${pin.offsetPx}px 0` };
            return (
              <button
                key={pin.id}
                data-testid="pin"
                type="button"
                className={`pin ${pin.band} ${alignClass}`}
                style={
                  {
                    left: `${pin.positionPct}%`,
                    ["--dot-color" as string]: paceColor,
                  } as React.CSSProperties
                }
                aria-label={`${name}: ${pace}, resets ${when}`}
                onClick={() => onSelectProvider(pin.id)}
              >
                {pin.band === "above" ? (
                  <>
                    <span className="pin-when" style={dodgeX}>{pin.estimated ? `${when} (est.)` : when}</span>
                    <span className={`pin-label ${paceCls}`} style={{ ...pinBorder, ...dodgeX }}>
                      {name}
                    </span>
                    <PinStem band={pin.band} offsetPx={pin.offsetPx} />
                    <span className="pin-dot" />
                  </>
                ) : (
                  <>
                    <span className="pin-dot" />
                    <PinStem band={pin.band} offsetPx={pin.offsetPx} />
                    <span className={`pin-label ${paceCls}`} style={{ ...pinBorder, ...dodgeX }}>
                      {name}
                    </span>
                    <span className="pin-when" style={dodgeX}>{pin.estimated ? `${when} (est.)` : when}</span>
                  </>
                )}
                <span className="pin-tooltip" role="tooltip">
                  <b>{name}</b>
                  <span className="pt-sep">·</span>
                  {provider?.quota ? `${provider.quota.weeklyPct}% used` : "no readings"}
                  <span className="pt-sep">·</span>
                  {left ? `${left} left` : when}
                  {pin.estimated ? " (est.)" : ""}
                </span>
              </button>
            );
          })}

          {placement.clusters.map((cluster, index) => {
            const alignClass = cluster.positionPct < 12 ? "pin-start" : cluster.positionPct > 88 ? "pin-end" : "";
            const dodgeX = cluster.offsetPx === 0 ? undefined : { translate: `${cluster.offsetPx}px 0` };
            return (
              <button
                key={cluster.ids.join("+")}
                data-testid="cluster-pin"
                type="button"
                className={`pin ${cluster.band} ${alignClass}`}
                style={
                  {
                    left: `${cluster.positionPct}%`,
                    "--dot-color": "var(--accent)",
                  } as React.CSSProperties
                }
                aria-label={`${cluster.ids.length} resets at the same time: ${cluster.ids.map((id) => byId.get(id)?.displayName ?? id).join(", ")}`}
                aria-expanded={openCluster === index}
                onClick={() => setOpenCluster(openCluster === index ? null : index)}
              >
                {cluster.band === "above" ? (
                  <>
                    <span className="pin-label" style={{ borderColor: "var(--accent)", color: "var(--accent)", ...dodgeX }}>
                      {cluster.ids.length} resets
                    </span>
                    <PinStem band={cluster.band} offsetPx={cluster.offsetPx} />
                    <span className="pin-dot" />
                  </>
                ) : (
                  <>
                    <span className="pin-dot" />
                    <PinStem band={cluster.band} offsetPx={cluster.offsetPx} />
                    <span className="pin-label" style={{ borderColor: "var(--accent)", color: "var(--accent)", ...dodgeX }}>
                      {cluster.ids.length} resets
                    </span>
                  </>
                )}
              </button>
            );
          })}

          {openCluster !== null && placement.clusters[openCluster] && (
            <ClusterPopover
              cluster={placement.clusters[openCluster]}
              providers={byId}
              asOfMs={asOfMs}
              onSelect={onSelectProvider}
              onClose={() => setOpenCluster(null)}
            />
          )}

          <div className="rail-days" aria-hidden="true">
            {labels.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
