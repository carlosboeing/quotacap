import React from "react";
import { CopyButton } from "../CopyButton.js";

const STARSHIP_SNIPPET = `[custom.quotacap]
command = "quotacap status --compact"
when = "command -v quotacap"
format = "[$output]($style) "`;

const TMUX_SNIPPET = `set -g status-right '#(quotacap status --compact)'`;

const SHELL_SNIPPET = `export PS1='$(quotacap status --compact) '$PS1`;

export function CliIntegrationPanel() {
  return (
    <div>
      <h3 className="settings-h3">Shell Prompt Integration</h3>
      <p className="settings-desc">
        Display active quota headroom in your shell prompt or multiplexer statusline:
      </p>

      <div className="cli-block">
        <b className="cli-block-label">
          Starship Prompt (<code>starship.toml</code>):
        </b>
        <div className="cli-wrap">
          <pre className="cli-snippet">{STARSHIP_SNIPPET}</pre>
          <CopyButton text={STARSHIP_SNIPPET} />
        </div>
      </div>

      <div className="cli-block">
        <b className="cli-block-label">
          tmux (<code>~/.tmux.conf</code>):
        </b>
        <div className="cli-wrap">
          <pre className="cli-snippet">{TMUX_SNIPPET}</pre>
          <CopyButton text={TMUX_SNIPPET} />
        </div>
      </div>

      <div className="cli-block">
        <b className="cli-block-label">
          Bash / Zsh (<code>~/.zshrc</code>):
        </b>
        <div className="cli-wrap">
          <pre className="cli-snippet">{SHELL_SNIPPET}</pre>
          <CopyButton text={SHELL_SNIPPET} />
        </div>
      </div>
    </div>
  );
}
