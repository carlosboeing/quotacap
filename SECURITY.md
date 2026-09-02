# Security Policy

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Report privately through GitHub's private vulnerability reporting (`Security → Advisories → New draft advisory`). If you cannot use private reporting, email **carlosboeing@gmail.com** with the same detail and `QuotaCap security` in the subject.

We will acknowledge within 48 hours and aim to ship a fix or mitigation within 7 days. We will credit you in the changelog unless you prefer to stay anonymous.

## What QuotaCap is

QuotaCap is a local quota tracker. It records one usage window per provider and estimates which provider to use next. It has no cloud service. The daemon, store, and HTTP handler run as your user on `127.0.0.1:8787`. See `docs/architecture.md` for the full model.

## What QuotaCap touches

- `~/.quotacap/` — `config.json`, `quotacap.db`, `token`, `daemon.pid`. Directory `0700`, files `0600` (`src/store/db.ts:openDb`, `src/http/server.ts:ensureToken`, `src/daemon.ts:ensureDaemonToken`).
- The CLIs you already run — `claude`, `codex`, `kimi`, `grok`, `agy` — by spawning them and reading their stdout. It does not modify them.
- No network beyond the local loopback handler — except the `claude`/`agy`/`codex`/`kimi`/`grok` binaries themselves contacting their own vendors when QuotaCap spawns them.

## What QuotaCap does not touch

- No tokens owned. It never reads `~/.codex/auth.json` (`CODEX_HOME`), `~/.kimi-code/credentials/kimi-code.json` or `~/.kimi/credentials/kimi-code.json`, `~/.grok/auth.json` (`GROK_HOME`), or `~/.gemini/oauth_creds.json`. It never uses `refresh_token` or `grant_type=refresh_token`. It has no hardcoded client ids. Those OAuth paths were removed in #14. This is asserted by `tests/adapters/credential-free.test.ts`.
- No `.qc-bak`, `.qc-lock`, or token writes. The old `persistCreds` helper no longer exists.
- No `raw` provider payload at rest or on the wire. The `raw` column was dropped and migrated in `src/store/db.ts:37-48`. `GET /api/quotas` and MCP `get_quotas` never return `raw` (`tests/http/api.test.ts`). `ParsedQuota.raw` is an in-memory debug slice that is never written to disk — PTY adapters cap at 4096 chars, `claude` keeps the full result text.
- No LAN surface. It binds `host: "127.0.0.1"` (`src/cli/index.ts:56`), not `0.0.0.0`.
- No prompt or repo content is sent anywhere by QuotaCap. The spawned CLIs may contact their vendors as they normally do.

## How the local HTTP surface is locked

- `Host` must be `127.0.0.1`, `localhost`, `[::1]`, or `::1` (with or without port), otherwise `403 forbidden host` (`src/http/server.ts:hostnameFromHostHeader`, `isLoopbackHostname`). This blocks DNS rebinding.
- `Origin` when present must be `http://` or `https://` with a loopback hostname, otherwise `403 forbidden origin` (`src/http/server.ts:isAllowedOrigin`). Absent `Origin` passes for `curl`, CLI, and MCP.
- `POST /api/refresh` requires `X-QuotaCap-Token` matching `~/.quotacap/token` (`0600`), compared with `crypto.timingSafeEqual`, otherwise `401` (`src/http/server.ts:isValidToken`). `GET /api/token` is same-origin gated. Refresh is debounced to 60 s.
- `GET /assets/*` decodes the splat, rejects `..` and absolute paths, resolves with `path.resolve(root, decoded)`, and requires the candidate to stay under the assets root (`src/http/server.ts:188-215`). `GET /assets//etc/passwd` → `400`.

## Adapter mechanisms and caveats

- Exec adapters — `claude` (`claude -p /usage --output-format json`, 8 s) and `agy` (`agy -p /usage --output-format json`, 20 s, emits `agy` and `agy:3p`) via `execFile` with an argv list, no shell (`src/adapters/claude.ts`, `src/adapters/agy.ts`). `claude` binary is pinned at daemon start via `which claude` (`src/daemon.ts:resolveClaudeExecPath`).
- PTY adapters — `codex` (`codex --no-alt-screen` → `/status`, 12 s), `kimi` (`kimi` → `/usage`, 8 s), `grok` (`grok` → `/usage`, 14 s, `creditsUsd`) via `src/adapters/pty.ts` (`node-pty`). The runner waits a settle delay or readiness regex, writes `\r`, collects until a completion regex or timeout, caps at 256 KiB, then kills clean.
- TUI-fragile: vendor text changes break the regex. The row then degrades fail-closed (stale) until the pattern is fixed. This is the trade-off for credential-free polling.
- Poll latency is 2–10 s per PTY provider. It dominates `POST /api/refresh` and the first poll. It does not affect the steady-state 15 m timer.
- `node-pty` is an `optionalDependency`. Exec adapters work without it. PTY adapters report `node-pty not available` and degrade gracefully when it is missing.

## Supported versions

Only the latest `main` and the latest tagged release receive fixes. Pin `install.sh` to a tag if you need reproducibility.

## Hardening history

See `docs/CHANGELOG.md` `0.0.22 — 2026-09-02` and `docs/architecture.md` Security model for the full audit fix list (audit `2026-08-30`, design `2026-09-01`).
