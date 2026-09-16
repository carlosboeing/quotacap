# QuotaCap Roadmap

## Recently shipped — 0.0.35 — 2026-09-17 (model catalog, weekly ledger & pace-normalized forecast)

* Live model catalog — tracks the currently listed models per quota bucket for all six providers (`agy`, `claude`, `codex`, `grok`, `kimi`, `muse`) via pure parsers, cached in SQLite with a configurable TTL; waiting surfaces (`GET /api/models`, `POST /api/models/refresh`, MCP `get_models`, CLI `models`) wait for fresh listings, while advisory surfaces join the cache without spawning processes and show `models:` with freshness indicators (#94)
* Weekly closed-window ledger — every detected weekly reset writes a `window_closes` receipt from the last old-window poll, so leftover (`100 − used`) survives the roll; shown on the dashboard card foot, the ledger Reset cell, the drawer Closed weeks strip, CLI `status` under RESETS, and MCP JSON, and the poll coordinator wakes five minutes before a known non-estimated weekly reset
* Pace-normalized forecast — `burnRate` becomes a blend of the recent 24h rate toward a history-anchored baseline, red requires a 15% deadband margin plus a cumulative gate on a verified clock, near-misses and uncertain positions read the new amber Watch tier, Ahead of pace returns for on-track boards clearly ahead of elapsed, and estimated resets cap at Watch with `burn now` demoted to `use soon` and verified-first ranking in `recommend()` (#96)

## Recently shipped — 0.0.34 — 2026-09-16 (initial poll settling, provider outage resilience & notice polish)

* Initial poll dashboard timing — `quotacap web` waits up to 5s for the daemon's initial background poll to settle before opening the browser, avoiding transient stale or not-reporting banners (#91)
* Muse and Codex resilience — recognizes upstream unavailable states without failing, detects Codex refresh token reuse immediately without hanging, and advises sending a prompt to warm session limits (#91)
* Refresh notice & status pill — green status pill preserved during rate-limit cooldown, and "Refresh cooling down" replaced with plain English "Already up to date — showing latest readings" (#91)

## Recently shipped — 0.0.33 — 2026-09-15 (dev loop, service stop, local install & versioning)

* Local dev loop — one-command `npm run dev` running auto-restarting daemon and Vite HMR dashboard with port guard and proxy (#86)
* Service stop resilience — macOS `service stop` tolerates dead process launchd error 3 instead of throwing (#87)
* Local install — one-command `npm run install:local` to compile standalone binary into `~/.local/bin` and reload background service (#88)
* Local build versioning — development builds append short git commit SHA (e.g. `0.0.33-<sha>`) with full takeover skew compatibility (#89)

## Recently shipped — 0.0.32 — 2026-09-15 (unified 5h limit)

* Unified 5h limit window — the drawer displays the granular 5-hour reset window titled "5h Limit" under "Weekly limit" for all providers with short windows (codex, kimi, agy, claude, muse), including when 0% used, and table rows use the consistent "5h Limit" label (#84)

## Recently shipped — 0.0.31 — 2026-09-15 (refresh settle, plan labels & table)

* Refresh settle — the header pill re-reads state until the daemon goes idle instead of sticking on Cooling down, and a refresh inside the server cooldown explains itself with a notice (#82)
* Plan labels — Codex reads the plan from the `/status` Account line; providers with no tier signal no longer print `unknown` in cards, rows, or the drawer (#82)
* Vendor window words — the drawer and table use each provider's own `/usage` or `/status` terms: Weekly limit plus 5-hour limit, Current session, or Current window (#82)
* Table polish — Reset stacks clock over countdown in a widened column, columns rebalance, rows gain hover, and usage headlines never break (#82)

## Recently shipped — 0.0.30 — 2026-09-14 (codex 5h reset & parse diagnostics)

* Codex 5h reset — the parser accepts the date-qualified 5h reset (`resets 02:43 on 15 Sep`) the `/status` panel renders once the window falls on another day, keeping the bare form for same-day resets; polls stay green across the turnover (#80)
* Parse diagnostics — adapter parse failures classify as `parse_error` with canonical wording instead of collapsing to unknown, and the dashboard failure banner renders the server diagnosis when the attempt carries one (#80)

## Recently shipped — 0.0.29 — 2026-09-14 (pace, reset accuracy & display)

* Reset rail fan-out — pins within a collision window now render individually up to three per window (was two), with band alternation and tier staggering carrying tight trios; clusters start at four (#78)
* Codex reset accuracy — the poll waits for the `/status` panel instead of completing on the startup statusline footer (which carries percentages but no reset times), parses the panel's progress-bar rows, and submits the command two-phase so the slash-command autocomplete can't swallow Enter; Codex reads a real `resets 23:04 on 19 Sep` again instead of a drifting now+7d estimate (#77)
* Table Reset column — the ledger's `Resets in` column becomes `Reset` and shows the actual reset day/time ahead of the countdown (`Tue 10:25 · in 20h 30m`), with the estimate marker staying on the timestamp (#76)
* Pace split — every advisory carries `avgPace` (used % / days elapsed) alongside the forecast input `burnRate`, and all surfaces show both: dashboard cards lead with the window average with the 24h rate beneath, CLI `status` gains a `PACE (%/DAY)` column, MCP markdown gains the Pace column, units unified on `%/day`; exhausted windows force at-risk + `Exhausted` forecast instead of reading on-track when recent burn is flat (#71)

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
* Provider error observability — bounded failure evidence from PTY and exec runners classified through a strict allowlist into canonical safe phrases, persisted on attempt records with clear-on-success, surfaced via `status --verbose` and MCP `forecast`, and logged as sanitized outcome lines per adapter

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

* Windows binary target (`bun-windows-x64`)
* `forecast` input validation (enum, error shape)
* Forecast constants fixture-locked only — re-run `scripts/forecast-backtest.mjs` against the live DB once `window_closes` holds receipts

## Future

* Task suitability & model capability routing — benchmark mapping, reasoning/context tier matching, and task profile selector (deferred to keep core advisory strictly economic)
* Auto-routing proxy (out of scope v1)
* Cloud sync, team mode
* `--buffer` flag (95% target option)

## Parked

* `tsconfig` split (node vs web) — deferred, DOM lib bleed low risk
* `package-lock.json` un-ignore — deferred
* Dashboard Playwright visual regression — deferred
