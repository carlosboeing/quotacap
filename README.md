# QuotaCap

See every AI subscription quota in one place. Use the one that would expire unused.

[![npm](https://img.shields.io/npm/v/quotacap)](https://www.npmjs.com/package/quotacap)
[![CI](https://github.com/carlosboeing/quotacap/actions/workflows/test.yml/badge.svg)](https://github.com/carlosboeing/quotacap/actions)
[![license](https://img.shields.io/github/license/carlosboeing/quotacap)](LICENSE)
[![node](https://img.shields.io/node/v/quotacap)](package.json)

![QuotaCap dashboard](https://raw.githubusercontent.com/carlosboeing/quotacap/main/docs/assets/dashboard.png)

## What you get

- **Usage** — percent used for each signed-in subscription
- **Reset** — when the current window ends
- **Use next** — which quota would expire unused if you keep current habits

## Providers

| Provider | Updates |
|---|---|
| Claude Code | Live — reuses your Claude Code login |
| Codex | Live — reuses your Codex login |
| Kimi Code | Live — reuses your Kimi Code login |
| Grok | Live — reuses your Grok login |
| Antigravity / Gemini | Paste with `quotacap ingest` |

Sign in to the provider CLI as usual. QuotaCap reuses that session. No API keys.

## Install

```bash
# Binary — macOS and Linux, arm64 and x64. No Node.
curl -fsSL https://raw.githubusercontent.com/carlosboeing/quotacap/main/install.sh | sh

# Or npm (Node 22.13+)
npm install -g quotacap
npx quotacap
```

The binary is a self-contained executable from GitHub Releases.
The npm package runs the same CLI on Node.

## Quick start

```bash
# Terminal 1 — leave this running
quotacap init                 # writes ~/.quotacap/config.json
quotacap web                  # dashboard at http://localhost:8787

# Terminal 2 — after the dashboard table fills
quotacap status
quotacap advise
```

Leave `web` running. It stays in the foreground and starts the daemon.

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

## Local only

Bound to `127.0.0.1`. No prompts or file contents leave the machine. QuotaCap stores no API keys. Adapters read the OAuth files the CLIs already own.

## Docs

- [Architecture](docs/architecture.md)
- [Changelog](docs/CHANGELOG.md)
- [Roadmap](docs/ROADMAP.md)

## License

MIT — see [LICENSE](LICENSE).

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
