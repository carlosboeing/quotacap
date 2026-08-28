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
# Binary — no Node needed (macOS + Linux, arm64/x64)
curl -fsSL https://raw.githubusercontent.com/carlosboeing/quotacap/main/install.sh | sh

# Or via npm (requires Node 22.13+; node:sqlite needs --experimental-sqlite before 22.13)
npm install -g quotacap   # global install
npx quotacap              # run without install
```

The binary is a self-contained Bun-compiled executable from GitHub Releases.
The npm package runs the same CLI on Node. Both put `quotacap` on your PATH.

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
    "quotacap": { "command": "quotacap", "args": ["mcp"] }
  }
}
```

Use `"command": "npx", "args": ["quotacap", "mcp"]` when installed via npm only.
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
{ "port": 8787, "pollMinutes": 15, "enabledProviders": ["claude"] }
```

DB is `~/.quotacap/quotacap.db` (`quotas`, `snapshots`).

## Development

```bash
npm test              # vitest run (10 files) — builds first via pretest
bun test tests/bun/   # bun-runtime tests (sqlite adapter, MCP translation)
npm run build         # vite build → embed web assets → tsc → flatten dist → chmod bin
npm run build:bin     # bun build --compile (current platform, or pass targets)
npx tsc --noEmit
```

The `store/db.ts` adapter picks `node:sqlite` on Node and `bun:sqlite` on Bun, so
the same code runs as an npm package and as a compiled binary.

See `.workbench/2-design/2026-08-28-quotacap-design.md` for spec. See `docs/ROADMAP.md` for next steps.

## License

MIT — see [LICENSE](LICENSE).
