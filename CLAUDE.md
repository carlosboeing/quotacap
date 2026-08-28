# QuotaCap — instructions for AI agents

This is the public QuotaCap repository (`carlosboeing/quotacap`). Private working memory (brainstorms, discovery, designs, plans, reviews, notes) lives in the sidecar `carlosboeing/quotacap-workbench`, cloned locally at `.workbench/` and gitignored here.

## What this repo is

QuotaCap is a local, cross-harness AI quota dashboard + harness-callable advice tool. It helps users maximize weekly/monthly caps across Claude, Codex/ChatGPT, Antigravity/Gemini, Kimi, Grok, OpenCode.

* Binary / npm: `quotacap` (`npx quotacap`), display name QuotaCap
* Stack (planned): TypeScript/Node, SQLite, Vite+React dashboard, daemon on :8787, adapters per provider, MCP server wrapping same HTTP handler
* Distribution: npm (`quotacap`), brew tap, `go install` considered; no hosted service

## Layout (public)

```
.
├── README.md
├── LICENSE
├── docs/          — public docs (installation, usage, architecture) — TBD
├── src/           — daemon, adapters, http, cli, mcp — TBD
├── tests/         — TBD
└── .workbench/    — PRIVATE sidecar (carlosboeing/quotacap-workbench), gitignored
```

Private workbench layout mirrors crossrev/copydesk: `0-brainstorms/`, `1-discovery/`, `2-design/`, `3-plans/`, `4-reviews/`, `notes/`, `guides/`.

## Routing — where to write

* **Public:** code, tests, public docs, ADRs, ROADMAP, CHANGELOG, templates
* **Private (`.workbench/`):** brainstorms, research, designs, plans, retros, scratch notes, product vision, business decisions

`git` at repo root → public. `git -C .workbench` → private. Never cross-commit. `.workbench/` is gitignored here — the strongest gate.

## Conventions

* Conventional Commits: `feat|fix|docs|chore: <description>`
* MIT license (LICENSE)
* One-line summary + trade-offs for proposals; terse lists/tables; file:line sources

## Current state

* Design shipped: `.workbench/2-design/2026-08-28-quotacap-design.md` (D dashboard: summary + strip + table, daemon+HTTP+MCP+CLI, phase 1 claude + manual)
* Spike verified: `claude -p "/usage" --output-format json` parses Spike sample; others stubbed
* Repos: `carlosboeing/quotacap` (public) and `carlosboeing/quotacap-workbench` (private) created 2026-08-28, cloned locally at `~/Projects/carlos/quotacap` with nested `.workbench/`

## Brand

* `quotacap` lowercase for binary/npm/repo/gh org
* `QuotaCap` display (like CrossRev / CopyDesk)
* Domain `quotacap.ai` available standard (~$80/yr), `.com` taken
