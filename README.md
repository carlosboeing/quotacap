# QuotaCap

**Cross-harness AI quota dashboard + harness-callable advice.**

One place to see how much of each AI subscription you've used. Shows when it resets and what to burn next. Goal is 100% use at reset.

Polls pluggable adapters (Claude, Codex, Gemini, Kimi, Grok, OpenCode). Stores history in SQLite. Serves:

* **Web dashboard** at `http://localhost:8787` — banner + 7-day strip + table with burn vs ideal. Includes stale badges and degraded banner.
* **CLI** `quotacap` / `npx quotacap` — `status`, `advise --json`, `ingest`, `web`, `init`, `daemon`
* **MCP server** — `get_quotas`, `get_recommendation`, `forecast` for any harness

Runs local-only by default. No prompts or file contents leave your machine.

## Install

```bash
npx quotacap              # run without install
npm install -g quotacap   # global install
```

Requires Node 22.6+.

## Quick start

```bash
quotacap init
quotacap ingest --provider kimi --text "Current week: 22% used · resets Aug 29 at 11am"
quotacap status --json
quotacap web                          # http://localhost:8787
quotacap advise --json                # tries HTTP, falls back to local DB
quotacap advise --json --task heavy
```

## HTTP API

```bash
curl http://localhost:8787/health
curl http://localhost:8787/api/quotas
curl "http://localhost:8787/api/recommendation?task=any"
curl -X POST http://localhost:8787/api/refresh
```

* `GET /health` → `{ok, uptime, lastPollAt}`
* `GET /api/quotas` → `Quota[]` with `stale`, `ageMs`
* `GET /api/recommendation?task=any` → `{use, reason, advisories}`
* `POST /api/refresh` → `{fulfilled, rejected, lastPollAt, degraded}` — debounced 60s, always 200
* `GET /` → `web/dist/index.html` if built, else `web/index.html`

## CLI

```
quotacap status [--json]
quotacap advise [--json] [--task any|heavy|light]
quotacap ingest --provider <id> --text "..."
quotacap web [--port 8787]
quotacap daemon [--foreground]
quotacap init
```

`advise` fetches `http://localhost:$port/api/recommendation` with 2s timeout. Falls back to local `recommend()` when daemon is down.

## MCP

```json
{
  "mcpServers": {
    "quotacap": { "command": "npx", "args": ["quotacap", "mcp"] }
  }
}
```

Tools: `get_quotas`, `get_recommendation`, `forecast`. Wrapper over HTTP. Set `QUOTACAP_URL` to override.

## How it works

```
Adapters (claude-cli ✓, manual ✓, others → manual-paste)
  → daemon (poll 15m + jitter, SQLite ~/.quotacap/quotacap.db)
  → HTTP :8787
  → dashboard + CLI + MCP (same handler)
```

Adapters are isolated. One failure does not block others. Uses `Promise.allSettled` and per-adapter catch. `POST /api/refresh` always 200.

## Config

`~/.quotacap/config.json`:

```json
{ "port": 8787, "pollMinutes": 15, "enabledProviders": ["claude", "manual"] }
```

DB is `~/.quotacap/quotacap.db` (`quotas`, `snapshots`).

## Development

```bash
npm test              # vitest run (10 files)
npm run build         # tsc && vite build --config web/vite.config.ts && cp -R dist/src/* dist/ && chmod +x dist/cli/index.js
npx tsc --noEmit
```

See `.workbench/2-design/2026-08-28-quotacap-design.md` for spec. See `docs/ROADMAP.md` for next steps.

## License

MIT — see [LICENSE](LICENSE).
