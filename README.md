# QuotaCap

QuotaCap helps you get more from the AI coding subscriptions you already pay for: Claude Code, Codex, Kimi Code, and Grok. It tracks one current usage window and reset time for each plan, then estimates which plan to use next from remaining usage and recent pace when available.

[![npm](https://img.shields.io/npm/v/quotacap)](https://www.npmjs.com/package/quotacap)
[![CI](https://github.com/carlosboeing/quotacap/actions/workflows/test.yml/badge.svg)](https://github.com/carlosboeing/quotacap/actions)
[![license](https://img.shields.io/github/license/carlosboeing/quotacap)](LICENSE)
[![node](https://img.shields.io/node/v/quotacap)](package.json)

## Features

- **Visibility**: remaining usage and reset time for one current window per connected plan
- **Pacing**: recent usage when history is available, or an estimated pace while QuotaCap collects it
- **Advice**: an estimate of which plan to use next so you can use more of each allowance without exhausting one early
- **Dashboard, CLI, and MCP**: the same data and advice on every surface

## Providers

| Provider | Source |
|---|---|
| Claude Code | Live |
| Codex | Live |
| Kimi Code | Live |
| Grok | Live |
| Antigravity / Gemini | Manual (`quotacap ingest`) |

Live adapters reuse the matching CLI login.

## Install

```bash
# Binary: macOS and Linux, arm64 and x64. No Node.
curl -fsSL https://raw.githubusercontent.com/carlosboeing/quotacap/main/install.sh | sh

# Or install with npm (Node 22.13+)
npm install -g quotacap
```

The binary is a self-contained executable from GitHub Releases.
The npm package runs the same CLI on Node. To run without a global install, replace `quotacap` with `npx quotacap` in any command, for example `npx quotacap web`.

## Quick start

```bash
# Terminal 1: leave this running
quotacap init                 # writes ~/.quotacap/config.json
quotacap web                  # dashboard at http://localhost:8787

# Terminal 2: after the dashboard table fills
quotacap status
quotacap advise
```

`web` stays in the foreground and starts the daemon.

For a provider without a live adapter:

```bash
quotacap ingest --provider agy --text "65% used · resets Sep 1"
```

## MCP

```json
{
  "mcpServers": {
    "quotacap": { "command": "quotacap", "args": ["mcp"] }
  }
}
```

Use `"command": "npx", "args": ["quotacap", "mcp"]` when installed via npm only.

Tools: `get_quotas`, `get_recommendation`, `forecast`.

## Privacy

Bound to `127.0.0.1`, with usage history stored under `~/.quotacap/`. Live adapters contact provider usage endpoints or invoke the provider CLI using your existing login. Codex, Kimi, and Grok adapters may refresh expired OAuth tokens and update the CLI-owned credential file. QuotaCap stores no API keys.

## Docs

- [Architecture](docs/architecture.md)
- [Changelog](docs/CHANGELOG.md)
- [Roadmap](docs/ROADMAP.md)

## License

MIT. See [LICENSE](LICENSE).

<details>
<summary>Development</summary>

```bash
npm test              # vitest (builds first via pretest)
bun test tests/bun/   # bun-runtime tests (sqlite adapter, MCP translation)
npm run build
npm run build:bin
```

The store uses `node:sqlite` on Node and `bun:sqlite` on Bun.
The same code is an npm package and a compiled binary.

</details>
