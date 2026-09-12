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

| Provider | Mechanism | Source |
|---|---|---|
| Claude Code | `exec` — `claude -p /usage --output-format json` | Live |
| Antigravity | `exec` — `agy -p /usage --output-format json` (two rows: Antigravity for Gemini, Antigravity 3P for third-party models) | Live |
| Codex | `pty` — `codex --no-alt-screen` then `/status`, parse `Weekly/5h limit: X% left` | Live |
| Kimi Code | `pty` — `kimi` then `/usage`, parse `Weekly/5h limit: Y% used` | Live |
| Grok | `pty` — `grok` then `/usage`, parse `Weekly limit (plan)` + `Credits: $X` | Live |
| Muse Code | `pty` — `muse --trust-workspace` then `/usage`, parse `Subscription · Muse Code <plan>` + `Weekly/Current N% used` | Live |

Exec adapters run via `execFile` with an argv list. PTY adapters run via `node-pty` (`src/adapters/pty.ts`). They are TUI-fragile: a vendor text change breaks the parser and the row degrades fail-closed until the regex is fixed. Poll latency is 2–10 s per PTY provider (settle plus completion). It dominates `POST /api/refresh` and the first poll, not the steady-state 15 m timer.

Live adapters invoke the CLIs you already logged into. No API keys. No token files are read.

## Install

```bash
# Binary: macOS and Linux, arm64 and x64. No Node.
curl -fsSL https://raw.githubusercontent.com/carlosboeing/quotacap/main/install.sh | sh

# Or install with npm (Node 22.13+)
npm install -g quotacap
```

The binary is a self-contained executable from GitHub Releases (shipped as `quotacap-<os>-<arch>.tar.gz` with a `pty` sidecar for Kimi/Codex/Grok); `install.sh` handles the tarball and sidecar transparently.
One command takes you from zero to a running tracker: the installer verifies checksums, provisions config, registers the background login service, and opens the dashboard. Re-running it upgrades in place with no flags. Pass `--no-service` (foreground only) or `--no-open` (SSH sessions) to skip steps.
The npm package runs the same CLI on Node. To run without a global install, replace `quotacap` with `npx quotacap` in any command, for example `npx quotacap web`.

## Quick start

```bash
quotacap            # opens the dashboard, starting the service if needed
quotacap status     # summary table (pass --verbose for adapter failure guidance)
quotacap advise
quotacap update     # upgrade to the latest release
quotacap providers list                    # view built-in and effective provider names
quotacap providers rename claude "Work"    # customize provider display name
quotacap providers reset claude            # restore built-in name (--all resets all)
```

No setup ceremony: config is provisioned on first use, and bare `quotacap` is the dashboard launcher. `quotacap status --verbose` displays actionable remediation guidance and sanitized failure details for failing adapters. `status` remains strictly read-only and never triggers background polling. `quotacap providers` manages custom display names (persisted to `~/.quotacap/config.json` under `providerNames`). `quotacap web --foreground` and `quotacap daemon` keep the old hold-the-terminal mode for SSH, containers, and supervisors.

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
| `PATCH` | `/api/providers/:id` | `X-QuotaCap-Token` | Set or clear custom provider display name override |

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

Set or clear a provider display name override:

```bash
# Set custom display name
curl -X PATCH http://localhost:8787/api/providers/claude \
  -H "X-QuotaCap-Token: $(cat ~/.quotacap/token)" \
  -H "Content-Type: application/json" \
  -d '{"displayName": "Work Claude"}'

# Reset to built-in name
curl -X PATCH http://localhost:8787/api/providers/claude \
  -H "X-QuotaCap-Token: $(cat ~/.quotacap/token)" \
  -H "Content-Type: application/json" \
  -d '{"displayName": null}'
```

## Security

QuotaCap is a local daemon. It binds to `127.0.0.1` only (`src/runtime/service.ts` `app.listen`). It does not listen on `0.0.0.0`. There is no LAN surface.

It owns no tokens. It never reads `~/.codex/auth.json`, `~/.kimi-code/credentials/kimi-code.json`, `~/.kimi/credentials/kimi-code.json`, `~/.grok/auth.json`, or `~/.gemini/oauth_creds.json`. It never uses `refresh_token` or `grant_type=refresh_token`. It has no hardcoded client ids. Those OAuth paths and the `.qc-bak` and `.qc-lock` helpers were removed in #14. This is asserted by `tests/adapters/credential-free.test.ts`. Each CLI owns its own session. It never reads `~/.config/muse/auth.json`, `~/.local/share/muse/sessions/`, or `~/.config/muse/tui-history.jsonl`. Each CLI owns its own session. QuotaCap only spawns the CLI and reads its stdout via `exec` (`claude`, `agy`) or PTY (`codex`, `kimi`, `grok`, `muse`).

It stores no `raw` provider payload. The `raw` column was dropped and migrated in `src/store/db.ts` `migrate`. `GET /api/quotas` and MCP `get_quotas` never return `raw` (`tests/http/api.test.ts`). History and the token live under `~/.quotacap/` with `0700` on the directory and `0600` on files.

Every request checks `Host` and `Origin`. `Host` must be loopback (`127.0.0.1`, `localhost`, `[::1]`), otherwise `403`. `Origin` when present must be loopback, otherwise `403`. Absent `Origin` passes for `curl` and MCP. `POST /api/refresh` requires `X-QuotaCap-Token` matching `~/.quotacap/token` with `crypto.timingSafeEqual` (`src/http/server.ts:isValidToken`), otherwise `401`. `GET /assets/*` is rooted with `path.resolve` and a prefix check (`tests/http/api.test.ts`).

Adapters fail closed. A timeout or unmatched TUI text becomes a stale row, never `0% used`. See `SECURITY.md` for the full "does and does not touch" list and how to report a vulnerability. See `docs/architecture.md` for the detailed security model.

## Docs

- [Architecture](docs/architecture.md)
- [Changelog](docs/CHANGELOG.md)
- [Roadmap](docs/ROADMAP.md)
- [Security](SECURITY.md)

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

The Muse adapter never trusts a directory of yours. It runs `muse --trust-workspace` with its working directory set to an empty folder QuotaCap owns (`~/.quotacap/muse-probe/`), so the flag has no project-local skills, rules, hooks or plugin config to load, and Muse's own flag does not persist trust. If a future Muse ignores the flag and shows the prompt anyway, the adapter aborts fail-closed rather than answering it.

The compiled binaries are built with `bun build --compile`.
Each `dist-bin/quotacap-<os>-<arch>.tar.gz` bundles a `pty` sidecar.
The sidecar is `pty/node-pty` with the matching prebuild.
`install.sh` verifies the tarball and installs the sidecar to `~/.local/bin/pty` and `~/.local/share/quotacap/pty`.

</details>
