import React from "react";

export function CliIntegrationPanel() {
  return (
    <div>
      <h3 style={{ fontSize: "var(--t-3)", fontWeight: 700, margin: "0 0 var(--s2)" }}>Shell Prompt Integration</h3>
      <p style={{ fontSize: "var(--t-2)", color: "var(--ink-soft)", margin: "0 0 var(--s3)" }}>
        Display active quota headroom in your shell prompt or multiplexer statusline:
      </p>

      <div style={{ marginBottom: "var(--s4)" }}>
        <b style={{ fontSize: "var(--t-2)", display: "block", marginBottom: 4 }}>
          Starship Prompt (<code>starship.toml</code>):
        </b>
        <pre
          style={{
            background: "var(--canvas)",
            padding: "8px 12px",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-sm)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--t-1)",
            margin: 0,
            overflowX: "auto",
          }}
        >
{`[custom.quotacap]
command = "quotacap status --compact"
when = "command -v quotacap"
format = "[$output]($style) "`}
        </pre>
      </div>

      <div style={{ marginBottom: "var(--s4)" }}>
        <b style={{ fontSize: "var(--t-2)", display: "block", marginBottom: 4 }}>
          tmux (<code>~/.tmux.conf</code>):
        </b>
        <pre
          style={{
            background: "var(--canvas)",
            padding: "8px 12px",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-sm)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--t-1)",
            margin: 0,
            overflowX: "auto",
          }}
        >
          {"set -g status-right '#(quotacap status --compact)'"}
        </pre>
      </div>

      <div style={{ marginBottom: "var(--s4)" }}>
        <b style={{ fontSize: "var(--t-2)", display: "block", marginBottom: 4 }}>
          Bash / Zsh (<code>~/.zshrc</code>):
        </b>
        <pre
          style={{
            background: "var(--canvas)",
            padding: "8px 12px",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-sm)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--t-1)",
            margin: 0,
            overflowX: "auto",
          }}
        >
          {"export PS1='$(quotacap status --compact) '$PS1"}
        </pre>
      </div>

      <div style={{ borderTop: "1px solid var(--line)", paddingTop: "var(--s3)" }}>
        <b style={{ fontSize: "var(--t-2)", display: "block", marginBottom: 4 }}>CLI Status Commands:</b>
        <p style={{ fontSize: "var(--t-2)", color: "var(--ink-soft)", margin: "0 0 6px" }}>
          Run status in terminal with custom sorting and ASCII fallbacks:
        </p>
        <code
          style={{
            display: "block",
            fontSize: "var(--t-1)",
            background: "var(--canvas)",
            padding: "6px 10px",
            borderRadius: "var(--r-sm)",
            border: "1px solid var(--line)",
            marginBottom: 4,
          }}
        >
          quotacap status --sort reset-asc
        </code>
        <code
          style={{
            display: "block",
            fontSize: "var(--t-1)",
            background: "var(--canvas)",
            padding: "6px 10px",
            borderRadius: "var(--r-sm)",
            border: "1px solid var(--line)",
          }}
        >
          quotacap status --ascii
        </code>
      </div>
    </div>
  );
}

