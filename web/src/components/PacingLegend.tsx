import React, { useEffect, useRef, useState } from "react";

const STATES: Array<{ label: string; cls: string; meaning: string }> = [
  { label: "On track", cls: "pace-ontrack", meaning: "Usage aligns with time (±20%)" },
  { label: "Behind pace", cls: "pace-behind", meaning: "Burning slow; risk of unused quota waste" },
  { label: "Ahead of pace", cls: "pace-ahead", meaning: "Burning faster than time; monitor usage" },
  { label: "Cap risk", cls: "pace-cap", meaning: "Will hit cap before reset window closes" },
  { label: "Not reporting", cls: "pace-out", meaning: "Adapter failed or credential stale" },
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
            <code>█</code> allowance used · <code>│</code> time elapsed · <code>░</code> projected waste
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

export function SiteFooter() {
  return (
    <footer className="sitefoot">
      <div className="sitefoot-start">
        <span>
          QuotaCap · local quota tracker · bound to <code>{servingHost()}</code>
        </span>
        <PacingLegend />
      </div>
      <span>MIT licence · no telemetry · history stays on this machine</span>
    </footer>
  );
}
