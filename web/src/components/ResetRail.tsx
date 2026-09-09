import React, { useEffect, useRef, useState } from "react";
import type { ProviderView } from "../state.js";
import { displayName } from "../names.js";
import { paceBadge, resetCountdown, timeLeft } from "./PaceBar.js";

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

function pinStyle(positionPct: number, band: RailBand, tier: number): React.CSSProperties {
  return {
    position: "absolute",
    left: `${positionPct}%`,
    transform: `translateX(-${positionPct}%)`,
    top: band === "above" ? undefined : "50%",
    bottom: band === "above" ? "50%" : undefined,
    marginBottom: band === "above" ? 10 + tier * 22 : undefined,
    marginTop: band === "below" ? 10 + tier * 22 : undefined,
  };
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
      style={{
        position: "absolute",
        zIndex: 30,
        left: `${cluster.positionPct}%`,
        transform: `translateX(-${cluster.positionPct}%)`,
        top: "50%",
        marginTop: 28,
        background: "var(--surface)",
        border: "1px solid var(--line)",
        borderRadius: 8,
        padding: 8,
        minWidth: 200,
      }}
    >
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {cluster.ids.map((id) => {
          const provider = providers.get(id);
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => {
                  onSelect(id);
                  onClose();
                }}
              >
                {displayName(id)}
                {provider?.quota ? ` · ${provider.quota.usedPct}% used` : ""}
                {provider ? ` · ${resetCountdown(provider, asOfMs)}` : ""}
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

function dayLabels(asOfMs: number): string[] {
  return Array.from({ length: RAIL_DAYS }, (_, i) =>
    new Date(asOfMs + i * 24 * 60 * 60 * 1000).toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
    })
  );
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
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <h2>Upcoming resets</h2>
        {placement.overflow.length > 0 && (
          <span
            data-testid="rail-overflow"
            title={placement.overflow.map((o) => displayName(o.id)).join(", ")}
            style={{ font: "var(--t-2)" }}
          >
            +{placement.overflow.length} beyond rail
          </span>
        )}
      </div>
      <div data-testid="rail" role="img" aria-label={`Upcoming resets over the next ${RAIL_DAYS} days`}>
        <div style={{ position: "relative", height: 8 }}>
          <div
            aria-hidden="true"
            style={{ position: "absolute", left: 0, right: 0, top: 3, height: 2, background: "var(--line)" }}
          />
          <span
            aria-hidden="true"
            style={{ position: "absolute", left: 0, top: -14, font: "var(--t-1)", color: "var(--accent)" }}
          >
            NOW
          </span>
          <div aria-hidden="true" style={{ display: "flex", justifyContent: "space-between" }}>
            {labels.map((label) => (
              <span key={label} style={{ font: "var(--t-1)" }}>
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div style={{ position: "relative", minHeight: 120 }}>
        {placement.placed.map((pin) => {
          const provider = byId.get(pin.id);
          const when = provider ? resetCountdown(provider, asOfMs) : "";
          const pace = provider ? paceBadge(provider) : "";
          const left = provider?.quota ? timeLeft(provider.quota.resetsAt, asOfMs) : null;
          return (
            <button
              key={pin.id}
              data-testid="pin"
              type="button"
              style={{
                ...pinStyle(pin.positionPct, pin.band, pin.tier),
                border: "1px solid var(--line-strong)",
                background: "var(--surface)",
                borderRadius: 999,
                padding: "4px 10px",
                font: "var(--t-2)",
                whiteSpace: "nowrap",
              }}
              aria-label={`${displayName(pin.id)}: ${pace}, resets ${when}`}
              title={
                provider?.quota
                  ? `${provider.quota.usedPct}% used · ${left ? `${left} left` : when}${pin.estimated ? " (est.)" : ""}`
                  : when
              }
              onClick={() => onSelectProvider(pin.id)}
            >
              {displayName(pin.id)}
              {pin.estimated ? " (est.)" : ""}
            </button>
          );
        })}
        {placement.clusters.map((cluster, index) => (
          <button
            key={cluster.ids.join("+")}
            data-testid="cluster-pin"
            type="button"
            style={{
              ...pinStyle(cluster.positionPct, cluster.band, cluster.tier),
              border: "1px solid var(--accent)",
              background: "var(--surface)",
              borderRadius: 999,
              padding: "4px 10px",
              font: "var(--t-2)",
              whiteSpace: "nowrap",
            }}
            aria-label={`${cluster.ids.length} resets at the same time: ${cluster.ids.map(displayName).join(", ")}`}
            aria-expanded={openCluster === index}
            onClick={() => setOpenCluster(openCluster === index ? null : index)}
          >
            {cluster.ids.length} resets
          </button>
        ))}
        {openCluster !== null && placement.clusters[openCluster] && (
          <ClusterPopover
            cluster={placement.clusters[openCluster]}
            providers={byId}
            asOfMs={asOfMs}
            onSelect={onSelectProvider}
            onClose={() => setOpenCluster(null)}
          />
        )}
      </div>
    </section>
  );
}
