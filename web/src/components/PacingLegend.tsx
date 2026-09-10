import React, { useState } from "react";

const STATES: Array<{ label: string; color: string; meaning: string }> = [
  { label: "On track", color: "var(--good)", meaning: "using quota as the window allows" },
  { label: "Behind pace", color: "var(--warn)", meaning: "quota will go unused at this rate" },
  { label: "Ahead of pace", color: "var(--ahead)", meaning: "using faster than the window allows" },
  { label: "Cap risk", color: "var(--danger)", meaning: "quota exhausts before reset" },
  { label: "Not reporting", color: "var(--line-strong)", meaning: "no usable reading; excluded from ranking" },
];

export function PacingLegend() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        className="btn btn-quiet btn-sm"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Pacing legend
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Pacing legend"
          style={{
            position: "absolute",
            zIndex: 20,
            right: 0,
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: 12,
            minWidth: 260,
          }}
        >
          <ul style={{ listStyle: "none", margin: 0, padding: 0, fontSize: "var(--t-2)" }}>
            {STATES.map((s) => (
              <li key={s.label}>
                <span aria-hidden="true" style={{ color: s.color }}>
                  ●{" "}
                </span>
                <strong>{s.label}</strong> — {s.meaning}
              </li>
            ))}
          </ul>
          <p style={{ fontSize: "var(--t-2)", marginBottom: 0 }}>
            Rail: <span aria-hidden="true">█</span> used · <span aria-hidden="true">│</span> elapsed ·{" "}
            <span aria-hidden="true">░</span> unused quota
          </p>
        </div>
      )}
    </div>
  );
}
