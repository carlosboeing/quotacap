import React, { useEffect, useRef, useState } from "react";
import type { ProviderView } from "../state.js";
import { paceBadge, resetClock, resetCountdown, timeLeft } from "./PaceBar.js";

export const RAIL_DAYS = 7;
const RAIL_MS = RAIL_DAYS * 24 * 60 * 60 * 1000;
/** Pins within this span of rail group into one collision window. */
const COLLISION_PCT = 3;
/** Pins per window before they group into a cluster pin. */
const WINDOW_CAPACITY = 2;

export interface RailRow {
  id: string;
  resetsAt: string | null;
  estimated?: boolean;
}

export type RailBand = "above" | "below";

export interface PlacedPin extends RailRow {
  positionPct: number;
  band: RailBand;
  tier: number;
}

export interface PinCluster {
  ids: string[];
  positionPct: number;
  band: RailBand;
  tier: number;
}

export interface PinPlacement {
  placed: PlacedPin[];
  clusters: PinCluster[];
  overflow: RailRow[];
  invalid: RailRow[];
}

/**
 * Place reset pins proportionally over the next 7 days from `asOf`.
 * Crowded windows past tier capacity group into clusters; resets beyond the
 * rail overflow; invalid rows are reported; reset-passed rows place no pin
 * (the ledger shows "awaiting fresh window" for them).
 */
export function placePins(rows: RailRow[], asOf: Date): PinPlacement {
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
    if (window.length <= WINDOW_CAPACITY) {
      for (const c of window) {
        items.push({
          kind: "pin",
          pin: { ...c.row, positionPct: c.positionPct, band: "above", tier: 0 },
        });
      }
    } else {
      const positionPct = window.reduce((sum, c) => sum + c.positionPct, 0) / window.length;
      items.push({
        kind: "cluster",
        cluster: { ids: window.map((c) => c.row.id), positionPct, band: "above", tier: 0 },
      });
    }
  }
  items.sort((a, b) => {
    const pa = a.kind === "pin" ? a.pin.positionPct : a.cluster.positionPct;
    const pb = b.kind === "pin" ? b.pin.positionPct : b.cluster.positionPct;
    return pa - pb;
  });

  // Alternate above/below bands; stagger tiers when same-band items crowd.
  const lastByBand: Record<RailBand, { position: number; tier: number }> = {
    above: { position: -Infinity, tier: 0 },
    below: { position: -Infinity, tier: 0 },
  };
  items.forEach((item, index) => {
    const target = item.kind === "pin" ? item.pin : item.cluster;
    const band: RailBand = index % 2 === 0 ? "above" : "below";
    const prev = lastByBand[band];
    const tier = target.positionPct - prev.position < COLLISION_PCT * 2 ? prev.tier + 1 : 0;
    target.band = band;
    target.tier = tier;
    lastByBand[band] = { position: target.positionPct, tier };
  });

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
                  {provider?.quota ? `${provider.quota.usedPct}% · ` : ""}
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

export function ResetRail({
  providers,
  asOf,
  onSelectProvider,
}: {
  providers: ProviderView[];
  asOf: string;
  onSelectProvider: (id: string) => void;
}) {
  const [openCluster, setOpenCluster] = useState<number | null>(null);
  const asOfMs = Date.parse(asOf);
  const byId = new Map(providers.map((p) => [p.id, p]));
  const rows: RailRow[] = providers
    .filter((p) => p.enabled && p.quota)
    .map((p) => ({ id: p.id, resetsAt: p.quota!.resetsAt, estimated: !!p.quota!.resetsAtEstimated }));
  const placement = placePins(rows, new Date(asOfMs));
  const labels = dayLabels(asOfMs);

  return (
    <section aria-label="Upcoming resets">
      <div className="section-head">
        <h2 id="resets-h">Upcoming resets</h2>
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
      </div>

      <div
        data-testid="rail"
        className="rail-scroller"
        tabIndex={0}
        role="region"
        aria-label={`Upcoming resets over the next ${RAIL_DAYS} days`}
      >
        <div className="rail">
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
            const tierClass = pin.tier > 0 ? `tier${pin.tier + 1}` : "tier1";
            const pinBorder = {
              ["--pin-border" as string]: `color-mix(in oklch, ${paceColor} 45%, var(--line))`,
            };
            return (
              <button
                key={pin.id}
                data-testid="pin"
                type="button"
                className={`pin ${pin.band} ${tierClass} ${alignClass}`}
                style={
                  {
                    left: `${pin.positionPct}%`,
                    "--dot-color": paceColor,
                  } as React.CSSProperties
                }
                aria-label={`${name}: ${pace}, resets ${when}`}
                onClick={() => onSelectProvider(pin.id)}
              >
                {pin.band === "above" ? (
                  <>
                    <span className="pin-when">{when}</span>
                    <span className={`pin-label ${paceCls}`} style={pinBorder}>
                      {name.split(" ")[0]}
                      {pin.estimated ? " (est.)" : ""}
                    </span>
                    <span className="pin-stem" />
                    <span className="pin-dot" />
                  </>
                ) : (
                  <>
                    <span className="pin-dot" />
                    <span className="pin-stem" />
                    <span className={`pin-label ${paceCls}`} style={pinBorder}>
                      {name.split(" ")[0]}
                      {pin.estimated ? " (est.)" : ""}
                    </span>
                    <span className="pin-when">{when}</span>
                  </>
                )}
                <span className="pin-tooltip" role="tooltip">
                  <b>{name}</b>
                  <span className="pt-sep">·</span>
                  {provider?.quota ? `${provider.quota.usedPct}% used` : "no readings"}
                  <span className="pt-sep">·</span>
                  {left ? `${left} left` : when}
                  {pin.estimated ? " (est.)" : ""}
                </span>
              </button>
            );
          })}

          {placement.clusters.map((cluster, index) => {
            const alignClass = cluster.positionPct < 12 ? "pin-start" : cluster.positionPct > 88 ? "pin-end" : "";
            const tierClass = cluster.tier > 0 ? `tier${cluster.tier + 1}` : "tier1";
            return (
              <button
                key={cluster.ids.join("+")}
                data-testid="cluster-pin"
                type="button"
                className={`pin ${cluster.band} ${tierClass} ${alignClass}`}
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
                    <span className="pin-label" style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>
                      {cluster.ids.length} resets
                    </span>
                    <span className="pin-stem" />
                    <span className="pin-dot" />
                  </>
                ) : (
                  <>
                    <span className="pin-dot" />
                    <span className="pin-stem" />
                    <span className="pin-label" style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>
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
