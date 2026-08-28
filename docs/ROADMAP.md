# QuotaCap Roadmap

## Recently shipped — MVP 0.0.1

* Project bootstrap, package, tsconfig
* Claude adapter (headless `claude -p "/usage"`), manual ingest, config read/write
* SQLite store + daemon `pollOnce` (15m + jitter, `Promise.allSettled` isolation)
* HTTP API `GET /health`, `/api/quotas`, `/api/recommendation`, `POST /api/refresh`, `GET /`
* Advisory engine (ideal/burn/waste/urgency, `recommend`)
* Web dashboard D — banner, 7-day strip, table, collapsible rows
* CLI `status`, `advise`, `ingest`, `web`, `init`, `daemon`
* MCP wrapper `get_quotas`, `get_recommendation`, `forecast`
* Integration polish — stale badge, degraded handling, `lastPollAt`, debounce 60s, `web/dist` prefer, snapshot fix

## Next

* Sniff Codex/Gemini/Kimi/Grok/OpenCode endpoints behind `enabledProviders` flags
* `web/dist` static serve + `vite build` in `npm run build`
* MCP stdio transport (`@modelcontextprotocol/sdk`)
* `forecast` latency (`Promise.all` parallel) and input validation

## Future

* Auto-routing proxy (out of scope v1)
* Cloud sync, team mode
* `--buffer` flag (95% target option)

## Parked

* `tsconfig` split (node vs web) — deferred, DOM lib bleed low risk
* `package-lock.json` un-ignore — deferred
* Dashboard Playwright visual regression — deferred
