# Changelog

## Unreleased

- Security: loopback `Host` and `Origin` allowlists, `X-QuotaCap-Token` on `POST /api/refresh` with `timingSafeEqual` and `~/.quotacap/token` (`0600`), `GET /api/token` same-origin gated, 60s debounce (#13). Rooted `GET /assets/*` with `path.resolve` and prefix check, reject `..` and absolute splats, `GET /assets//etc/passwd` → `400` (#7).
- Store: drop `raw` column and migrate old databases by rebuilding the table (`src/store/db.ts`), `mapRow` strips `raw` so `GET /api/quotas` and MCP never return it, add `credits_usd` and `resets_at_estimated`, `0700`/`0600` on `~/.quotacap` and `quotacap.db` (#12).
- Daemon: exclusive `O_EXCL` pidfile with liveness check and stale-steal, pinned `claude` binary via `which claude` at start, `execFile` argv lists (#8).
- Adapters credential-free: PTY runner `src/adapters/pty.ts` via `node-pty` (settle delay or readiness, completion regex, 256 KiB cap, kill clean) and Kimi adapter (`kimi` → `/usage`, 8 s timeout) (#11), Codex adapter (`codex --no-alt-screen` → `/status`, 12 s) and Grok adapter (`grok` → `/usage`, 14 s, `creditsUsd`) with TUI-fragile parsers and 2–10 s poll latency, `source: "tui"` (#12). `agy` dual-group rows `agy` (Gemini) and `agy:3p` (3p) from `agy -p /usage` (`exec`, 20 s) (#9). Retire OAuth HTTP path: remove `refresh_token`/`grant_type`/`auth.json`/`persistCreds`/`.qc-bak`/hardcoded client ids, adapters now `exec` (`claude`, `agy`) or PTY (`codex`, `kimi`, `grok`) only (#14).
- Advisory: pace from rolling 24 h poll history and cold-start headroom handling (#6), estimated resets surfaced (`resetsAtEstimated`) (#12).
- Release: `SHA256SUMS` generated and verified in `install.sh`, `npm ci` in workflows (#10).

## 0.0.21

- Provider adapter: Antigravity (`agy`) — headless `agy -p /usage --output-format json`, extracts Gemini weekly bucket and 5h session window, fail-closed error handling; `enabledProviders` defaults to claude, codex, kimi, grok, agy

## 0.0.20

- npm metadata: `description`, `license: MIT`, `keywords`, `bugs` (replaces the old README-extract listing)
- Public README: visitor intro, Features, live vs paste providers, estimate not a leftover-quota guarantee

## 0.0.19

- Provider adapters: codex (wham/usage), kimi (coding/v1/usages), grok (cli-chat-proxy billing) — reuses each CLI's OAuth session, zero API keys; `enabledProviders` defaults to claude, codex, kimi, grok
- Adapter core: OAuth refresh on expiry with rotated pairs persisted in place, cross-process lock, unique temp names, `0600` modes preserved
- Burn-rate history and advisory unchanged; new adapters feed the same dashboard, CLI, and MCP tables
- Docs: `docs/architecture.md` (components, system diagram, commands, data model, security model)

