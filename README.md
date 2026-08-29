# QuotaCap

QuotaCap helps you maximize the AI coding subscriptions you already pay for (Claude Code, Codex, Kimi Code, Grok). Each has its own usage window and reset time. It shows remaining usage in one table, and estimates which plan to use next from recent usage.

[![npm](https://img.shields.io/npm/v/quotacap)](https://www.npmjs.com/package/quotacap)
[![CI](https://github.com/carlosboeing/quotacap/actions/workflows/test.yml/badge.svg)](https://github.com/carlosboeing/quotacap/actions)
[![license](https://img.shields.io/github/license/carlosboeing/quotacap)](LICENSE)
[![node](https://img.shields.io/node/v/quotacap)](package.json)

## Features

- **Visibility**: remaining usage and reset time for every signed-in subscription
- **Maximize**: helps you use more of each allowance without exhausting one plan before its reset
- **Advice**: estimates which plan to use next from recent usage
- **CLI and MCP**: `status`, `advise`, and tools that return the same data

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

# Or npm (Node 22.13+)
npm install -g quotacap
```

The binary is a self-contained executable from GitHub Releases.
The npm package runs the same CLI on Node. With npm only, prefix commands with `npx`, for example `npx quotacap web`.

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
