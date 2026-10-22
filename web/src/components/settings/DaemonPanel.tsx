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
      <h3 className="settings-h3">Local Daemon Process</h3>
      <p className="settings-desc">
        Background process managing provider adapters and SQLite store.
      </p>

      <dl className="dkv">
        <dt>HTTP Service</dt>
        <dd>
          <code>127.0.0.1:{port ?? "8787"}</code>
        </dd>
        <dt>Polling Cadence</dt>
        <dd>Every 15 minutes (default)</dd>
        <dt>Database File</dt>
        <dd>
          <code>~/.quotacap/quotacap.db</code>
        </dd>
      </dl>

      <p className="settings-note">
        Change the port and polling cadence in <code>~/.quotacap/config.json</code> (<code>port</code>,{" "}
        <code>pollMinutes</code>; defaults 8787 and 10), then restart the daemon. These controls stay
        read-only until the server offers a settings API.
      </p>
    </div>
  );
}
