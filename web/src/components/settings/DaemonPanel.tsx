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
      <h3 style={{ font: "var(--t-4)", marginTop: 0 }}>
        Daemon
      </h3>
      <div>
        <label style={{ font: "var(--t-3)" }}>
          HTTP port{" "}
          <input
            type="number"
            value={port ?? ""}
            placeholder="8787"
            disabled={true}
            aria-label="Daemon HTTP port (read-only)"
          />
        </label>
        {port && (
          <p style={{ font: "var(--t-2)" }}>This dashboard is served from port {port}.</p>
        )}
      </div>
      <div>
        <label style={{ font: "var(--t-3)" }}>
          Poll cadence (minutes){" "}
          <input
            type="number"
            value=""
            placeholder="15"
            disabled={true}
            aria-label="Background poll cadence in minutes (read-only)"
          />
        </label>
      </div>
      <p style={{ font: "var(--t-2)" }}>
        Change the port and polling cadence in <code>~/.quotacap/config.json</code> (<code>port</code>,{" "}
        <code>pollMinutes</code>; defaults 8787 and 15), then restart the daemon. These controls stay
        read-only until the server offers a settings API.
      </p>
    </div>
  );
}
