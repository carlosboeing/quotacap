# QuotaCap

**Cross-harness AI quota dashboard + harness-callable advice.**

One place to see how much of each AI subscription you've used, when it resets, and what to burn next — so you hit 100% without leaving quota on the table.

Polls pluggable adapters (Claude, Codex/ChatGPT, Antigravity/Gemini, Kimi, Grok, OpenCode), stores history in local SQLite, and serves:

* **Web dashboard** at `http://localhost:8787` — summary banner + 7-day reset strip + detailed table with burn rate vs ideal, collapsible timeline rows
* **CLI** `quotacap` / `npx quotacap` — `status`, `advise --json`, `ingest`
* **MCP server** `quotacap` — `get_quotas`, `get_recommendation`, `forecast` so any harness (Claude Code, Codex, Opencode, Antigravity, Kimi, Grok) can ask “what should I use next?”

Local-only by default. No prompts, responses, or file contents leave your machine.

## Status

Pre-0.1 — design at `.workbench/2-design/2026-08-28-quotacap-design.md`. Building in public.

## Install (planned)

```bash
npx quotacap            # no install
npm install -g quotacap
brew install carlosboeing/tap/quotacap
```

## How it works

```
Adapters (claude-cli ✓, others stubbed → manual-paste)
  → quotacap daemon (poll 15m, SQLite history, advisory engine)
  → HTTP :8787
  → web dashboard + CLI + MCP (same handler)
```

See `.workbench/2-design/2026-08-28-quotacap-design.md` for the full spec, spike findings, and rollout plan.

## License

MIT — see [LICENSE](LICENSE).
