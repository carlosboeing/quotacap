# Changelog

## 0.0.23

- Install: one command from zero to dashboard — `install.sh` verifies checksums, provisions config, registers the background login service, waits for readiness, and opens the browser, with `upgrading existing install` re-runs, `--no-service`/`--no-open` flags, a PATH-shadow warning, and a `loginctl enable-linger` hint on Linux.
- Launcher: bare `quotacap` opens the dashboard through the shared `web` launcher (healthy daemons open, registered services start, last resort foreground-starts with a service suggestion); `init` keeps stdout JSON with guidance on stderr plus `--quiet` and `--force`; config provisions on demand everywhere.
- Update: `quotacap update` with install-channel detection (standalone swap, npm reinstall, print-only brew/pnpm/yarn guidance), `--check`/`--json`, a passive daily `updates.json` signal surfaced in CLI footers, `/api/state`, and a dashboard badge — never silent auto-update.
- Runtime: CLI newer than the daemon takes over via managed restart or graceful `/api/restart` handoff instead of exit 2; wedged daemons print PID-free recovery instructions; Linux gains a systemd user unit mirroring the macOS LaunchAgent; bootstrap retries across the launchd teardown window.
- PTY: Bun-spawned adapters get a genuine terminal (`terminal` option verified on Bun 1.3.11), fixing `stdin is not a terminal` (#42); Grok reset timestamps parse without a space after the comma; npm `postinstall` removed with best-effort `spawn-helper` permission repair at load.
- Observability: provider error diagnostics and verbose status — captures bounded failure evidence from PTY (merged transcript) and exec (stderr and status) runners through a strict allowlist classifier with canonical safe phrases and secret omission; persists nullable diagnostic fields on attempt records with backward-compatible PRAGMA migration and clear-on-success; exposes diagnostics via `status --verbose` (strictly read-only) and MCP `forecast`; logs sanitized, timestamped outcome lines per adapter.

## 0.0.22

- Dashboard: restyle settings connections, provider/advice drawers, recommendation spacing, and the health/site footer to the signed-off concept (#36).
- Hide manual ingest (CLI command, HTTP route, and docs) behind a default-off experimental flag until the product design is settled.
- CLI & MCP (Track D): Terminal commands (`status`, `advise`) and stdio MCP server over shared projection with labeled offline fallback and fixed-clock parity (#34).
- Dashboard (Track C): Responsive Vite+React dashboard with decision-ranked rows, pace bar, reset rail, provider drawer, and theme switching (#33).
- Runtime (Track B): Heartbeat-locked single-instance daemon coordinator, coalesced poller, and macOS login service (#32).
- Store & Advisory (Track A): Idempotent schema migration for session percentage, per-adapter attempt tracking, rolling pace estimation, and shared snapshot projection (#31).
- Governance & CI: Align repository with OSS house standard. Immutable action commit SHA pinning with version comments across all workflows (`test.yml`, `release.yml`).
- CI: Deterministic `npm ci` installation, Node compatibility floor (`22.13.0`) and current (`22`) matrix testing with `fail-fast: false`, stable aggregate gate check `required`.
- Release: Arch-matched binary execution smoke tests to prevent runner cross-compilation crashes, artifact provenance attestations via `actions/attest-build-provenance`.
- Supply chain: Automated weekly Dependabot configuration for GitHub Actions and npm dependencies (`.github/dependabot.yml`).
- Community health: Added `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1), pull request template, structured GitHub issue forms, `CODEOWNERS`, and `THIRD_PARTY_NOTICES.md`.


## 0.0.21

- Security: loopback `Host` and `Origin` allowlists, `X-QuotaCap-Token` on `POST /api/refresh` with `timingSafeEqual` and `~/.quotacap/token` (`0600`), `GET /api/token` same-origin gated, 60s debounce (#13). Rooted `GET /assets/*` with `path.resolve` and prefix check, reject `..` and absolute splats, `GET /assets//etc/passwd` → `400` (#7).
- Store: drop `raw` column and migrate old databases by rebuilding the table (`src/store/db.ts`), `mapRow` strips `raw` so `GET /api/quotas` and MCP never return it, add `credits_usd` and `resets_at_estimated`, `0700`/`0600` on `~/.quotacap` and `quotacap.db` (#12).
- Daemon: exclusive `O_EXCL` pidfile with liveness check and stale-steal, pinned `claude` binary via `which claude` at start, `execFile` argv lists (#8).
- Adapters credential-free: PTY runner `src/adapters/pty.ts` via `node-pty` (settle delay or readiness, completion regex, 256 KiB cap, kill clean) and Kimi adapter (`kimi` → `/usage`, 8 s timeout) (#11), Codex adapter (`codex --no-alt-screen` → `/status`, 12 s) and Grok adapter (`grok` → `/usage`, 14 s, `creditsUsd`) with TUI-fragile parsers and 2–10 s poll latency, `source: "tui"` (#12). `agy` dual-group rows `agy` (Gemini) and `agy:3p` (3p) from `agy -p /usage` (`exec`, 20 s) (#9). Retire OAuth HTTP path: remove `refresh_token`/`grant_type`/`auth.json`/`persistCreds`/`.qc-bak`/hardcoded client ids, adapters now `exec` (`claude`, `agy`) or PTY (`codex`, `kimi`, `grok`) only (#14).
- Advisory: pace from rolling 24 h poll history and cold-start headroom handling (#6), estimated resets surfaced (`resetsAtEstimated`) (#12).
- Provider adapter: Antigravity (`agy`) — headless `agy -p /usage --output-format json`, extracts Gemini weekly bucket and 5h session window, fail-closed error handling; `enabledProviders` defaults to claude, codex, kimi, grok, agy
- Release: `SHA256SUMS` generated and verified in `install.sh`, `npm ci` in workflows (#10).
- Docs: `docs/architecture.md`, `README.md`, `SECURITY.md` aligned with the hardened implementation (#15).

## 0.0.20

- npm metadata: `description`, `license: MIT`, `keywords`, `bugs` (replaces the old README-extract listing)
- Public README: visitor intro, Features, live vs paste providers, estimate not a leftover-quota guarantee

## 0.0.19

- Provider adapters: codex (wham/usage), kimi (coding/v1/usages), grok (cli-chat-proxy billing) — reuses each CLI's OAuth session, zero API keys; `enabledProviders` defaults to claude, codex, kimi, grok
- Adapter core: OAuth refresh on expiry with rotated pairs persisted in place, cross-process lock, unique temp names, `0600` modes preserved
- Burn-rate history and advisory unchanged; new adapters feed the same dashboard, CLI, and MCP tables
- Docs: `docs/architecture.md` (components, system diagram, commands, data model, security model)

