# QuotaCap Roadmap

## Recently shipped — 0.0.28 — 2026-09-13 (grok accuracy)

* Grok accuracy — the adapter reads the `/usage` dialog used percent instead of the startup `limit left` remaining figure, so Grok reports 100% used instead of a pinned 0%

## Recently shipped — 0.0.27 — 2026-09-13 (seamless updates)

* Seamless updates — install upgrades wait for the port to be released on both backends, and the post-update refresh runs quiet so a good update prints three lines
* Always-visible versions — `status`/`advise` print the CLI (and differing daemon) version on stderr, the dashboard footer shows the daemon version

## Recently shipped — 0.0.26 — 2026-09-13 (update-check resilience)

* Version resolution without the API bucket — latest tag from the releases-page redirect, JSON seam kept behind `QUOTACAP_RELEASE_BASE_URL`, rate-limit failures diagnosed with reset time
* Negative update cache and reachable pin — failed refreshes back off 30 minutes while serving the cached `latest`; `update --version` (shadowed, never worked) renamed to `update --to`

## Recently shipped — 0.0.25 — 2026-09-13 (upgrade path & display fixes)

* Service restart race — wait for the port to be released between stop and start, so `quotacap update` stops reporting a failed restart on a successful upgrade (#61)
* Reset rail labels — full display names instead of the first word, and the estimate marker on the timestamp rather than the provider name (#62)
* Release smoke retry and doc citation de-rot — five-minute registry window, symbol citations instead of rotting `file:line` references (#60)

* Provider auto-enable on daemon start — `knownProviders` key, PATH detection per unknown adapter, deliberate disables stick, pre-feature configs backfill the five
* Post-update service registration refresh — managed takeovers reinstall (regenerating the supervisor PATH) with the target version threaded through `install`'s idempotent comparison

## Recently shipped — 0.0.24 — 2026-09-12 (provider naming & Muse Code)

* Provider naming standard — one server-side registry supplies `displayName`, `vendor`, `harness` and `description` per provider id, applied once in `buildSnapshot` and carried as additive output-only fields on `/api/state` and MCP `get_quotas`; CLI wide/narrow tables and MCP Markdown labels render display names, compact statuslines stay id-based, ids stay frozen as the contract, and the dashboard's private name map is retired (#52)
* Provider adapter — Muse Code (`muse`): PTY scrape of the TUI `/usage` panel with a terminal capability-query responder and a two-phase submit in `runPty`, run credential-free in an empty QuotaCap-owned probe directory with auto-update disabled, weekly window to `usedPct` and rolling current window to `sessionPct`, fail-closed aborts on trust prompt, accidental model turn, and unavailable subscription; `enabledProviders` defaults to all six (#53)
* Naming version skew — a CLI newer than a still-running daemon falls back to raw ids at the ingest boundary rather than crashing `status` in the column-width calculation (#54)
* Provider display name overrides — user-set names per provider id resolved server-side as `user override → built-in registry → raw id`, editable via `providerNames` in config, `PATCH /api/providers/:id`, the `quotacap providers` CLI group, and click-to-rename in the dashboard drawer, with rendering-safety validation and raw-JSON persistence that preserves unrecognized config keys (#57)
* npm package trimmed — compiled tests and a duplicate `dist/src/` no longer ship, bringing the tarball back under its 500 kB release budget (#59)

## Recently shipped — 0.0.22 — 2026-09-10

* Dashboard visual follow-up — settings connections, drawers, recommendation gap, and health/site footer matched to the signed-off concept (#36)
* Hide manual ingest behind a default-off experimental flag (CLI, HTTP, public docs)
* Track D — terminal CLI (`status`, `advise`) and stdio MCP clients with labeled offline fallback and fixed-clock parity (#34)
* Track C — responsive React dashboard with decision-ranked provider rows, reset rail, pace bar, provider drawer, and theme switching (#33)
* Track B — runtime coordinator, heartbeat-locked ownership, coalesced poller, and macOS login item service (#32)
* Track A — store persistence with session percentage, attempts tracking, pacing engine, and shared snapshot projection (#31)
* OSS house-standard alignment — immutable action SHA pinning, `npm ci`, Node 22.13/22 matrix with `required` gate, arch-matched release smoke tests, provenance attestations, Dependabot, community health files (#16, #24)

## Recently shipped — 0.0.21 — 2026-09-02

* Security hardening — `Host` and `Origin` loopback allowlists and `X-QuotaCap-Token` on `POST /api/refresh` (`timingSafeEqual`, `~/.quotacap/token` `0600`) (#13), rooted `GET /assets/*` against absolute splats `GET /assets//etc/passwd` → `400` (#7), `0700`/`0600` on `~/.quotacap` and `quotacap.db` with `raw` column dropped and migrated, `credits_usd` + `resets_at_estimated` added (#12), exclusive `O_EXCL` pidfile with stale-steal and pinned `claude` path (#8), 24 h rolling burn (#6) and estimated resets (#12), `SHA256SUMS` + `npm ci` in release (#10)
* Credential-free adapters — PTY runner `src/adapters/pty.ts` (`node-pty`, settle/readiness, completion regex, 256 KiB cap) and Kimi (`kimi` → `/usage`, 8 s) (#11), Codex (`codex --no-alt-screen` → `/status`, 12 s) and Grok (`grok` → `/usage`, 14 s, `creditsUsd`) via TUI scraping, `source: "tui"`, TUI-fragile fail-closed, 2–10 s poll latency (#12), `agy` dual-group `agy` (Gemini) + `agy:3p` (3p) via `agy -p /usage` exec 20 s (#9), retire OAuth HTTP path — no reads of `~/.codex/auth.json`, `~/.kimi-code/credentials/kimi-code.json`, `~/.grok/auth.json`, no `refresh_token`/`grant_type`/`.qc-bak`/hardcoded client ids (#14)
* Docs truth pass — `docs/architecture.md`, `README.md`, `SECURITY.md` aligned with hardened code (#15)
* Provider adapter — Antigravity (`agy`): headless `agy -p /usage --output-format json`, maps Gemini weekly bucket and 5h session window, fail-closed degraded rows; `enabledProviders` defaults to all five

## Recently shipped — 0.0.20

* npm `package.json` description, MIT license, and keywords (registry listing no longer the old README extract)
* Public README rewrite: maximize as aim, advice as estimate, live vs paste providers

## Recently shipped — 0.0.19

* Provider adapters — codex (wham/usage), kimi (coding/v1/usages), grok (cli-chat-proxy billing): reuse CLI OAuth sessions, refresh-on-expiry with rotated tokens persisted (`.qc-bak`), fail-closed degraded rows; `enabledProviders` defaults to all four
* Adapter-hardening review fixes — expiry-unit parity with CLIs, locked atomic persists, `0600` modes preserved, matched-entry token rotation
* Public architecture doc (`docs/architecture.md`)

## Recently shipped — MVP 0.0.1

* Project bootstrap, package, tsconfig
* Claude adapter (headless `claude -p "/usage"`), manual ingest, config read/write
* SQLite store + daemon `pollOnce` (15m + jitter, `Promise.allSettled` isolation)
* HTTP API `GET /health`, `/api/quotas`, `/api/recommendation`, `POST /api/refresh`, `GET /`
* Advisory engine (ideal/burn/waste/urgency, `recommend`)
* Web dashboard D — banner, 7-day strip, table, collapsible rows
* CLI `status`, `advise`, `ingest`, `web`, `init`, `daemon`
* MCP wrapper `get_quotas`, `get_recommendation`, `forecast`
* MCP stdio transport — hand-rolled JSON-RPC (`initialize`, `tools/list`, `tools/call`, `ping`, daemon-down translation)
* Integration polish — stale badge, degraded handling, `lastPollAt`, debounce 60s, `web/dist` prefer, snapshot fix
* PR #1 review fixes — daemon keepalive, `/assets/*` serving, engines 22.13, pretest build, manual `skipped` status, stale-reset fallback

## Distribution (Bun)

* `src/store/db.ts` dual-runtime adapter — `node:sqlite` on Node, `bun:sqlite` on Bun (same sync API)
* `scripts/build-embed.mjs` — embeds `web/dist` into `src/webHtml.ts` + `src/webAssets.ts` (committed, regenerated by build)
* HTTP serves embedded dashboard as fallback — single-file binary needs no filesystem
* `npm run build:bin` — `bun build --compile` (current platform by default, any target via args)
* `install.sh` — downloads `quotacap-<os>-<arch>.tar.gz` from GitHub Releases to `~/.local/bin`, verifies `SHA256SUMS`
* `.github/workflows/release.yml` — binaries + npm publish on `v*` tags, `npm ci`

* `test.yml` CI — vitest + bun-runtime tests on every PR and push to main

## Recently shipped — 0.0.23 — 2026-09-11 (install & update lifecycle)

* One-command install: provision config, register login service, wait for readiness, open dashboard; upgrades re-run flag-free
* `web` launcher, bare `quotacap`, on-demand config, `init` JSON contract with `--quiet`/`--force`
* `quotacap update` with channel detection, passive daily signals, CLI footer + API + dashboard badge
* Daemon takeover on version skew, wedged recovery without PID killing, Linux systemd user unit
* Bun PTY genuine terminal and Grok reset parsing ([#42](https://github.com/carlosboeing/quotacap/issues/42)), npm `postinstall` removal

## Next

* Provider error observability — safe bounded diagnostics, sanitized failure classifier, attempt persistence, verbose CLI status guidance, and MCP parity
* Windows binary target (`bun-windows-x64`)
* `forecast` input validation (enum, error shape)
* Advisory: consume `resetsAtEstimated` in recommendation engine (last open thread from #12)

## Future

* Task suitability & model capability routing — benchmark mapping, reasoning/context tier matching, and task profile selector (deferred to keep core advisory strictly economic)
* Auto-routing proxy (out of scope v1)
* Cloud sync, team mode
* `--buffer` flag (95% target option)

## Parked

* `tsconfig` split (node vs web) — deferred, DOM lib bleed low risk
* `package-lock.json` un-ignore — deferred
* Dashboard Playwright visual regression — deferred
