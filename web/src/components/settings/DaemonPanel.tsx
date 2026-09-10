import React from "react";

function servingPort(): string | null {
  try {
    const port = window.location.port;
    return port ? port : null;
  } catch {
    return null;
  }
}

/**
 * Daemon preferences. No server config API exists yet, so these controls are
 * inert: they show what is known and point at the config file.
 */
export function DaemonPanel() {
  const port = servingPort();
  return (
    <div>
      <h3 style={{ fontSize: "var(--t-3)", fontWeight: 700, margin: "0 0 var(--s2)" }}>Local Daemon Process</h3>
      <p style={{ fontSize: "var(--t-2)", color: "var(--ink-soft)", margin: "0 0 var(--s4)" }}>
        Background process managing provider adapters and SQLite store.
      </p>

      <div style={{ display: "grid", gap: "var(--s2)", fontSize: "var(--t-2)", marginBottom: "var(--s4)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
          <span style={{ color: "var(--ink-soft)" }}>HTTP Service</span>
          <code>127.0.0.1:{port ?? "8787"}</code>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
          <span style={{ color: "var(--ink-soft)" }}>Polling Cadence</span>
          <span>Every 15 minutes (default)</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
          <span style={{ color: "var(--ink-soft)" }}>Storage Engine</span>
          <span>SQLite</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
          <span style={{ color: "var(--ink-soft)" }}>Database File</span>
          <code>~/.quotacap/quotacap.db</code>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gap: "var(--s3)",
          background: "var(--surface-raised)",
          padding: "var(--s4)",
          borderRadius: "var(--r-md)",
          border: "1px solid var(--line)",
        }}
      >
        <div>
          <label style={{ fontSize: "var(--t-2)", fontWeight: 600, display: "block", marginBottom: 4 }}>
            HTTP port
          </label>
          <input
            type="number"
            value={port ?? "8787"}
            placeholder="8787"
            disabled={true}
            aria-label="Daemon HTTP port (read-only)"
            style={{
              width: "100%",
              boxSizing: "border-box",
              font: "inherit",
              fontSize: "var(--t-2)",
              padding: "6px 10px",
              borderRadius: "var(--r-sm)",
              border: "1px solid var(--line)",
              background: "var(--surface)",
              color: "var(--ink-soft)",
            }}
          />
          {port && (
            <p style={{ fontSize: "var(--t-1)", color: "var(--ink-soft)", margin: "4px 0 0" }}>
              This dashboard is served from port {port}.
            </p>
          )}
        </div>

        <div>
          <label style={{ fontSize: "var(--t-2)", fontWeight: 600, display: "block", marginBottom: 4 }}>
            Poll cadence (minutes)
          </label>
          <input
            type="number"
            value="15"
            placeholder="15"
            disabled={true}
            aria-label="Background poll cadence in minutes (read-only)"
            style={{
              width: "100%",
              boxSizing: "border-box",
              font: "inherit",
              fontSize: "var(--t-2)",
              padding: "6px 10px",
              borderRadius: "var(--r-sm)",
              border: "1px solid var(--line)",
              background: "var(--surface)",
              color: "var(--ink-soft)",
            }}
          />
        </div>
      </div>

      <p style={{ fontSize: "var(--t-1)", color: "var(--ink-soft)", marginTop: "var(--s3)" }}>
        Change the port and polling cadence in <code>~/.quotacap/config.json</code> (<code>port</code>,{" "}
        <code>pollMinutes</code>; defaults 8787 and 15), then restart the daemon. These controls stay
        read-only until the server offers a settings API.
      </p>
    </div>
  );
}

