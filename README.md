# QuotaCap

QuotaCap helps you get more from the AI coding subscriptions you already pay for: Claude Code, Codex, Kimi Code, Grok, and Antigravity. It tracks one current usage window and reset time for each plan, then estimates which plan to use next from remaining usage and recent pace when available.

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
| Antigravity | Live |

Live adapters reuse the matching CLI login.

## Install

```bash
# Binary: macOS and Linux, arm64 and x64. No Node.
curl -fsSL https://raw.githubusercontent.com/carlosboeing/quotacap/main/install.sh | sh

# Or install with npm (Node 22.13+)
npm install -g quotacap
```

The binary is a self-contained executable from GitHub Releases (shipped as `quotacap-<os>-<arch>.tar.gz` with a `pty` sidecar for Kimi/Codex/Grok); `install.sh` handles the tarball and sidecar transparently.
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

## HTTP API

The local web server listens on `127.0.0.1:8787` (configured via `QUOTACAP_URL` or `~/.quotacap/config.json`). All endpoints enforce loopback `Host` (`127.0.0.1`, `localhost`, `[::1]`) and reject foreign `Origin` headers (403) to prevent DNS rebinding and cross-origin requests.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | None | Health check and uptime |
| `GET` | `/api/quotas` | None | Current quotas for all providers |
| `GET` | `/api/recommendation` | None | Current advisory on which provider to use next |
| `GET` | `/api/token` | Same-origin | Shared secret token for the dashboard |
| `POST` | `/api/refresh` | `X-QuotaCap-Token` | Trigger an immediate adapter poll (debounced to 60s) |

### Curl examples

Read current quotas:

```bash
curl http://localhost:8787/api/quotas
```

Trigger an immediate refresh (requires the shared secret in `~/.quotacap/token` with mode `0600`):

```bash
curl -X POST http://localhost:8787/api/refresh \
  -H "X-QuotaCap-Token: $(cat ~/.quotacap/token)"
```

## Privacy

Bound to `127.0.0.1`, with usage history and authentication token stored under `~/.quotacap/` (directory mode `0700`, files mode `0600`). HTTP endpoints enforce loopback `Host` and `Origin` allowlists to prevent DNS rebinding and cross-origin access. Mutating routes (`POST /api/refresh`) require the `X-QuotaCap-Token` header. Live adapters contact provider usage endpoints or invoke the provider CLI using your existing login (Claude Code, Antigravity). Codex, Kimi, and Grok adapters run credential-free PTY sessions. QuotaCap stores no API keys.

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

`node-pty` is a native addon for the PTY-based adapters (Kimi, Codex, Grok) and is an `optionalDependency`. Prebuilt binaries are provided where available (macOS and Linux). If no prebuild matches your Node version or platform, `npm install` compiles it from source — this requires Xcode (macOS) or `build-essential` + `python3` (Linux). If the compile fails the install still succeeds and exec-based adapters (Claude, Agy) continue to work; PTY adapters will report `node-pty not available` until you install the toolchain and run `npm rebuild node-pty`.

The Kimi adapter spawns `kimi` in your home directory so the quota modal does not depend on the project path. If Kimi shows `Trust this folder?`, QuotaCap fails closed with `untrusted workspace — run \`kimi\` there and select Trust this folder` and does not auto-trust; trust remains an explicit interactive decision.

The compiled binaries are built with `bun build --compile`.
Each `dist-bin/quotacap-<os>-<arch>.tar.gz` bundles a `pty` sidecar.
The sidecar is `pty/node-pty` with the matching prebuild.
`install.sh` verifies the tarball and installs the sidecar to `~/.local/bin/pty` and `~/.local/share/quotacap/pty`.

</details>
