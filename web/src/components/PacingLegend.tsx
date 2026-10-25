import React, { useEffect, useRef, useState } from "react";

// What each badge means. Actions belong to the Use more / Ease off lanes.
const STATES: Array<{ label: string; cls: string; meaning: string }> = [
  { label: "On track", cls: "pace-ontrack", meaning: "The forecast lands at or near 100% at reset" },
  { label: "Behind pace", cls: "pace-behind", meaning: "The forecast leaves quota unused at reset" },
  { label: "Ahead of pace", cls: "pace-ahead", meaning: "More used than time elapsed; the forecast still reaches reset" },
  { label: "Cap risk", cls: "pace-cap", meaning: "The forecast runs out well before reset, and usage is ahead of time" },
  { label: "Quota exhausted", cls: "pace-cap", meaning: "Quota is 100% used until the next reset" },
  { label: "Watch", cls: "pace-watch", meaning: "The forecast runs out near or before reset, or the reset time is estimated" },
  { label: "Measuring", cls: "pace-out", meaning: "Under 6 hours of readings; no forecast yet" },
  { label: "Not reporting", cls: "pace-out", meaning: "No usable reading; left out of the advice" },
];

export function PacingLegend() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="legend-wrap" ref={rootRef}>
      <button
        type="button"
        className="legend-btn"
        aria-expanded={open}
        aria-controls="pacing-legend"
        onClick={() => setOpen((v) => !v)}
      >
        Pacing Legend ▾
      </button>
      {open && (
        <div
          id="pacing-legend"
          className="legend-popover"
          role="dialog"
          aria-label="Pacing legend"
        >
          <div className="legend-head">
            <b>Pacing Scale Legend</b>
            <button
              type="button"
              className="legend-close"
              aria-label="Close pacing legend"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </div>
          <p className="legend-intro">Pacing measures quota burn against elapsed window time:</p>
          <div className="legend-rows">
            {STATES.map((s) => (
              <div key={s.label} className="legend-row">
                <span className={`pace ${s.cls}`}>{s.label}</span>
                <span>{s.meaning}</span>
              </div>
            ))}
          </div>
          <div className="legend-foot">
            <code>█</code> quota used · <code>│</code> time elapsed · <code>░</code> projected waste
          </div>
          <div className="legend-foot">
            Avg = used ÷ days elapsed · 24h = burn over the last day · Ideal = remaining ÷ days left
          </div>
        </div>
      )}
    </div>
  );
}

function servingHost(): string {
  try {
    return window.location.hostname || "127.0.0.1";
  } catch {
    return "127.0.0.1";
  }
}

export function SiteFooter({ version }: { version?: string }) {
  const name = version ? `QuotaCap v${version}` : "QuotaCap";
  return (
    <footer className="sitefoot">
      <div className="sitefoot-start">
        <span>
          {name} · local quota tracker · bound to <code>{servingHost()}</code>
        </span>
        <PacingLegend />
      </div>
      <span>MIT licence · no telemetry · history stays on this machine</span>
    </footer>
  );
}
