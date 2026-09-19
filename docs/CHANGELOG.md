# Changelog

## 0.0.38 — unreleased

- Provider adapter — OpenCode Go (`opencode-go`, opt-in): `GET https://opencode.ai/zen/go/v1/usage` with the OpenCode auth key read in-memory once per poll after explicit consent (`quotacap providers enable opencode-go` or the dashboard modal); detection by file existence never auto-enables, `POST /api/providers/:id/enabled` is token-gated with `consent: true` required, disable revokes consent, weekly maps to `usedPct` with a real reset (pre-reset wake and closed-week receipts for free) and rolling to the 5h Limit; the credential-free gate now allows the `auth.json` literal in exactly `src/adapters/opencode-go.ts` and asserts the read is read-only and entry-scoped; monthly stays parked (no field yet)

## 0.0.37

- Muse recovery: when the `/usage` panel reports `Currently unavailable`, the poll now sends up to three minimal `muse exec "hi"` warm turns (empty probe dir, 20 s cap, 3 s settles, 60 s budget) and re-reads usage after each, so a stale subscription snapshot recovers without a manual prompt; healthy polls send nothing, and an exhausted recovery shows the same degraded row as before.

## 0.0.36

- Reset rail pin accuracy: edge pins clamp their label and timestamp to the rail instead of translating the whole pin button, so the dot stays on its reset time coordinate and pins render in chronological order (#101).

## 0.0.35

- Live model catalog: tracks currently listed models per quota bucket across all six providers (`agy`, `claude`, `codex`, `grok`, `kimi`, `muse`) via pure parsers, cached in `model_catalogs` in SQLite with configurable TTL (`catalogTtlHours`, default 6h). Waiting surfaces (`GET /api/models`, `POST /api/models/refresh`, MCP `get_models`, and CLI `quotacap models`) wait up to 30s for fresh listings; non-waiting advisory surfaces (`advise`, MCP `get_recommendation`, `/api/recommendation`, `/api/state`) join the cache without spawning CLI processes and display `models:` with freshness indicators. Catalog fetching uses in-process coalescing, a 60s failure cooldown, and catalog-owned abort signals isolated from usage polling.
- Weekly closed-window ledger: every detected weekly reset writes a `window_closes` receipt from the last old-window poll, so leftover (`100 − used`) survives the roll instead of vanishing. The dashboard shows it in the card foot, the ledger Reset cell, and a Closed weeks strip in the drawer (oldest left, up to four weeks); CLI `status` prints one dim line under RESETS; MCP `get_quotas` and `forecast` JSON carry `lastCloses`. The poll coordinator wakes five minutes before a known, non-estimated weekly `resetsAt` instead of waiting for the ordinary cadence, skipping the pull-forward within 25 seconds of the roll or after a poll already landed in the lead window.
- Pace-normalized forecast: `burnRate` becomes a blend of the recent 24h rate and a history-anchored baseline (`baseline + 0.5 × (recent − baseline)`), where the baseline is the prior-week daily mean of up to 4 `window_closes` receipts (verified closes preferred, the window average as fallback, and a fresh window with neither still reads Measuring exactly as before), so one heavy day stops projecting as the whole future. Red now requires both a deadband margin around the exhausts-at-reset boundary (15%) and a cumulative gate (position no more than 10% behind elapsed time, on a verified clock); near-misses and uncertain positions read the new amber Watch tier across the dashboard badge and copy, CLI `status`, and MCP, and on-track windows clearly ahead of elapsed read Ahead of pace again. Estimated clocks cap at Watch (an exhausted window stays red — emptiness is measured, not forecast), demote `burn now` to `use soon`, and rank behind verified candidates in `recommend()`, closing the last open `resetsAtEstimated` thread from #12. Constants `K=0.5`, `M=0.15`, `T=0.10` are locked by the golden fixture replayed by `scripts/forecast-backtest.mjs`. The dashboard's clear banner now requires a board with no at-risk or Watch provider; the engine no longer carries an on-track "no priority" reason (documented in the architecture Forecast section).
- Architecture: the store/poll contract documents the `window_closes` table and the plain `pollMinutes` timer (the stale "15 minutes plus jitter" claim is gone), plus the ledger's honest limits — stale pre-reset readings, estimated clocks, sleeping laptops, and detection lag up to one poll interval.

## 0.0.34

- Initial poll dashboard timing: `quotacap web` waits up to 5s for the daemon's initial background poll to settle before opening the browser; the dashboard suppresses transient `stale` and `not-reporting` fault banners while a poll is in progress and re-reads state every 1000ms until readings arrive (#91).
- Muse and Codex resilience: recognizes when Meta's subscription usage reporting displays `Currently unavailable` or Codex indicates `Limits: refresh requested` (`service_unavailable` diagnostic code) rather than failing with an unparseable weekly usage error; detects OpenAI Codex refresh token reuse and re-login requirements (`auth` diagnostic code) immediately without hanging; updates recovery advice to suggest sending an inference prompt to warm session limits (#91).
- Header status pill and refresh notice: keeps the green "daemon live" health status during the 60s post-refresh rate-limit cooldown, reserving the amber indicator exclusively for active in-progress polls; replaces the confusing "Refresh cooling down" banner with "Already up to date — showing latest readings." (#91)

## 0.0.33

- Local dev loop (`npm run dev`): starts the backend daemon with auto-restart on `src` changes alongside the Vite HMR server in one command with joint shutdown; proxies `/api` and `/health` requests to the daemon, refuses to run when port 8787 is held by the service, and provides `npm run dev -- --open` for instant browser launch (#86).
- Service stop resilience: `quotacap service stop` on macOS tolerates `Boot-out failed: 3: No such process` when the job record exists in launchd but the daemon process has already exited, treating it as nothing-to-stop instead of throwing an unhandled exception (#87).
- Local build installation (`npm run install:local`): compiles the standalone binary for the current machine architecture (`bun-darwin-arm64`, `bun-linux-x64`, etc.), installs it into `~/.local/bin/quotacap` (along with the `pty/` sidecar), and automatically reloads the background service if running (#88).
- Local build commit tagging: unreleased builds installed via `install:local` automatically embed the short git commit SHA and optional `-dirty` suffix (e.g. `0.0.33-dde6274`), making local versions immediately identifiable in the CLI and dashboard footer; version comparison recognizes commit builds as up-to-date against base releases for seamless takeover (#89).

## 0.0.32

- Unified 5h limit window: the drawer displays the granular 5-hour reset window titled "5h Limit" under "Weekly limit" consistently across all providers that report a short window (Codex, Kimi, Agy, Claude Code's "Current session", Muse Code's "Current window"), rendering even when 0% is used rather than hiding flat windows. Table rows use the unified "5h Limit" label.

## 0.0.31

- Refresh settle: the dashboard fetched state only on load and after Refresh, so the post-refresh snapshot — always mid-cooldown — froze the header pill on "Cooling down" forever. The dashboard now re-reads `/api/state` every 5s while the daemon reports a non-idle poll state, and a refresh that lands inside the server cooldown shows a "Refresh cooling down — showing last readings" notice instead of silently returning cached rows.
- Plan labels: Codex parses the plan from the `/status` panel's `Account: <email> (<plan>)` line instead of reporting unknown; providers that expose no tier (kimi, agy — both verified live to carry no plan signal) now hide the `unknown` placeholder in cards, rows, and the drawer subtitle rather than printing it.
- Table polish: the Reset cell stacks clock over countdown (`Thu 16:53` / `in 2d 17h`) in a widened column instead of wrapping mid-phrase; columns rebalance, header/body padding aligns, rows gain a hover tint, pace labels get breathing room, and the `N% used` headline never breaks.

## 0.0.30

- Codex 5h reset: the `/status` panel renders the 5h reset date-qualified (`resets 02:43 on 15 Sep`) when it falls on another day, but the parser only accepted bare `HH:MM` — every poll since the window turned over failed with `bad 5h reset`. The 5h parser now accepts the weekly-shaped qualified form and keeps the bare form for same-day resets.
- Diagnostics: adapter parse failures are recognized as `parse_error` instead of collapsing to `unknown` — the classifier now matches QuotaCap's own adapter vocabulary (`bad 5h reset`, `weekly limit not found`, `no weekly bucket`, …) and emits the canonical phrase only, never the quoted provider value. Logs, `status --verbose`, and MCP show e.g. `Unable to read Codex usage: bad 5h reset` with the update-or-report recovery step.
- Dashboard: the failure banner renders the server diagnosis (summary, detail, action) when the attempt carries one, falling back to the legacy `Unknown error — check the X CLI, then re-poll` wording for old daemons and legacy attempts.

## 0.0.29

- Reset rail fan-out: pins within a collision window now render individually up to three per window (was two), with the band alternation and tier staggering carrying the layout; windows of four or more still group into a cluster pin with the per-provider popover. Trios with sub-hour gaps render with overlapping labels — accepted trade-off, the cluster popover remains the clean view for four-plus.
- Codex reset accuracy: the poll completed on Codex v0.154.0's startup statusline footer (`· 5h N% left · weekly N% left`), which carries no reset timestamps, so the adapter fell back to a `now + 7d` estimate that drifted forward on every poll (and pinned time-elapsed at 0%). The scrape now submits `/status` two-phase (the slash-command autocomplete swallows a same-burst Enter) and completes only on the rendered panel, whose progress-bar rows (`Weekly limit: [████…] 77% left (resets 23:04 on 19 Sep)`) the parser now reads — Codex reports a real reset timestamp again instead of `(est.)`.
- Table Reset column: the ledger's `Resets in` column is renamed `Reset` and shows the actual reset day/time ahead of the countdown — `Tue 10:25 · in 20h 30m` — with the estimate marker on the timestamp (`Mon 13:34 (est.) · in 6d 23h`), matching the reset rail's convention. Reset-passed, invalid, and reading-less rows keep their existing wording.
- Pace split: every advisory now carries `avgPace` (used % / days elapsed over the window) alongside the forecast input `burnRate`, and all surfaces show both — dashboard cards lead with the window average with the 24h rate beneath (`10.6%/day` + `24h 0.0%/day`), the CLI `status` wide table gains a `PACE (%/DAY)` column (narrow appends the pair, `--json` gains `avgPace`), and the MCP markdown table gains the Pace column, with units unified on `%/day`. Forecasts still use recent pace when measured; rankings and badges are unchanged.
- Exhausted windows: a provider with nothing remaining now forces at-risk + an `Exhausted` forecast instead of reading on-track when recent burn is flat.

## 0.0.28

- Grok accuracy: the adapter matched the TUI startup line `Weekly limit left: N%` (remaining quota) and reported it as used, pinning Grok at 0% while the `/usage` dialog showed 100% used. The parser now reads the dialog header first — tolerating the cursor-repositioned `limt` spelling with the percent on the next line — excludes `left` lines from the legacy same-line match, converts a lone `left` figure to used as 100−N, and takes the last `Resets:` line so re-renders supersede earlier frames; the poll waits for the dialog instead of completing on the startup line.

## 0.0.27

- Service install upgrades wait for the port to be released before loading the replacement on both backends, closing the stop→start race the post-update refresh path could still hit after it moved from `restart` to `install`; a port that never frees warns and starts anyway, never worse than before.
- Quiet post-update refresh: managed takeovers pass `quiet` through to `install`, so a good update prints its own three lines (`Updated`, the takeover note, the release URL) instead of ~17 lines of install detail. Failures still throw and stay loud.
- CLI version line: `status` and `advise` print `quotacap <cli>` on stderr (TTY only, never under `--json` or `--compact`), appending the daemon version when the reachable daemon reports one that differs. Stdout stays byte-clean.
- Dashboard footer shows `QuotaCap v<version>` from the running daemon, falling back to the existing text when the version is unknown.

## 0.0.26

- Update checks without the API bucket: `resolveLatestVersion` reads the latest tag from the releases-page redirect `Location` instead of the anonymous GitHub API, whose 60/hour budget is shared with every other API consumer on the machine; the JSON behaviour stays behind `QUOTACAP_RELEASE_BASE_URL` for hermetic tests and mirrors.
- Negative update cache: failed `refreshUpdateCache` attempts stamp `lastFailureAt` and suppress further network calls for 30 minutes while the previously cached `latest` keeps being served; `checkedAt` is untouched so the daily check is unaffected, success clears the stamp, the field is optional so existing `updates.json` files keep loading, and a late failure re-reads before stamping so it never clobbers a newer successful write.
- Pinned updates reachable: `quotacap update --version <v>` never worked — the global `--version` flag shadowed it — so the option is renamed to `update --to <version>`, which also pins past an unresolvable release.
- Rate-limit diagnosis: `quotacap update` names an exhausted anonymous API bucket with its reset time and points at the `--to` escape hatch; genuine network failures keep the generic message.

## 0.0.25

- Service restart: `restart` now waits for the port to be released between stopping and starting. `launchctl bootout` and `systemctl --user stop` both return before the job is gone, so the replacement raced the dying process for the port and `quotacap update` reported `service did not become ready on port 8787` on upgrades that had in fact succeeded, leaving the daemon stopped. Both backends wait, warn and start anyway if the port never frees, and keep tests off the real daemon's port via `deps.port`.
- Dashboard: the reset rail renders the whole provider display name instead of its first word, so `Antigravity` and `Antigravity 3P` no longer share a label, and the estimate marker moves from the name pill onto the timestamp it qualifies (`Codex` + `Sun 02:04 (est.)`, not `Codex (est.)`). Pill width is bounded so a long custom name cannot push its neighbours off the rail.
- Release and docs: the post-publish registry check retries for five minutes rather than sixty seconds, since npm propagation made it fail on a release that had published correctly, and reports the real cause when the window is exhausted. Documentation cites symbols instead of `file:line`, which had rotted to the point of naming a file the loopback bind had left.

- Provider auto-enable: new `knownProviders` config key records which adapters the daemon has already considered; at every start each registered adapter (minus `manual`) absent from it is resolved on PATH and appended to both `enabledProviders` and `knownProviders` when found, so newly shipped adapters light up on upgrade whatever the channel. Absent binaries stay unknown for the next start, known-but-disabled providers are never re-added, and configs predating the key backfill the pre-0.0.24 five so `muse` reads as new. Raw-JSON persistence preserves unknown keys and writes only on change.
- Post-update registration refresh: managed `quotacap update` takeovers reinstall the login service instead of only restarting it, regenerating the supervisor PATH from current provider locations via `install`'s existing idempotent comparison; the target version travels with the call because the update runs in the old binary.

## 0.0.24

- Naming: one server-side provider registry gives every row a `displayName` (the dashboard now reads `Antigravity` and `Antigravity 3P`), carries `vendor`, `harness` and `description` additively on `/api/state` and MCP `get_quotas`, and moves the CLI wide/narrow tables and MCP Markdown labels off raw ids; compact statuslines stay id-based. A CLI newer than a still-running daemon falls back to raw ids at the ingest boundary instead of crashing in the column-width calculation.
- User overrides (A5): custom provider display names across configuration (`providerNames` map in `config.json`), HTTP (`PATCH /api/providers/:id` with loopback token auth), CLI (`quotacap providers list|rename|reset`), and dashboard (click-to-rename in the provider drawer). Server-side resolution applies `user override → built-in registry → raw id`, carrying the effective name on `displayName` while providing `builtinName` on snapshots so the UI displays `Built-in: <name>` when overridden. Overrides are protected with strict rendering validation (rejecting control characters, ANSI escape sequences, bidirectional overrides, and invisible zero-width formatting characters) and safe raw-JSON persistence that preserves unrecognized configuration keys without schema stripping.
- Provider adapter: Muse Code (`muse`) — PTY scrape of the TUI `/usage` panel (`muse --trust-workspace` in an empty QuotaCap-owned probe directory, `MUSE_NO_AUTO_UPDATE=1`, 14 s budget), mapping the weekly window to `usedPct` and the rolling current window to `sessionPct`; `enabledProviders` defaults to all six. `runPty` gains two opt-in capabilities it needs: a terminal capability-query responder (cursor position, device attributes, OSC colour) and a two-phase `submitInput`/`submitAfterMs` write for TUIs whose autocomplete swallows a same-burst Enter. Aborts fail-closed on the trust prompt, on an accidental model turn, and on an unavailable subscription.

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

