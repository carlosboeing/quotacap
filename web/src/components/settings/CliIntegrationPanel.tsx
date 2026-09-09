import React from "react";

/**
 * Shell prompt snippets. The exact `status --compact` spelling lands with
 * track D; until then this tab is a placeholder with no invented flags.
 */
export function CliIntegrationPanel() {
  return (
    <div>
      <h3 style={{ font: "var(--t-4)", marginTop: 0 }}>CLI &amp; Shell</h3>
      <p style={{ font: "var(--t-3)" }}>
        Shell prompt snippets are pending track D. Once the CLI contract lands, this tab will offer
        copyable Starship, tmux, and PS1 integrations.
      </p>
    </div>
  );
}
