# QuotaCap — instructions for AI agents

This is the public QuotaCap repository (`carlosboeing/quotacap`). Private working memory (brainstorms, discovery, designs, plans, reviews, notes) lives in the sidecar `carlosboeing/quotacap-workbench`, cloned locally at `.workbench/` and gitignored here.

## What this repo is

QuotaCap is a local quota tracker for AI coding subscriptions. It records one current usage window per provider and estimates which plan to use next from remaining usage and recent pace when available. The dashboard, CLI, and MCP server expose the same data.

* Binary / npm: `quotacap` (`npx quotacap`), display name QuotaCap
* Stack: TypeScript/Node, SQLite, Vite+React dashboard, daemon on :8787, adapters per provider, MCP server wrapping same HTTP handler
* Distribution: npm (`quotacap`), GitHub Releases binaries (macOS and Linux); brew tap and `go install` considered; no hosted service

## Layout (public)

```
.
├── README.md
├── LICENSE
├── install.sh
├── docs/          — architecture, changelog, roadmap
├── src/           — daemon, adapters, http, cli, mcp
├── web/           — Vite+React dashboard
├── tests/
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

* Five live adapters: claude, codex, kimi, grok, agy, plus manual ingest
* npm `quotacap` and GitHub Releases binaries (macOS and Linux)
* Dashboard, CLI, and MCP share one local HTTP handler on 127.0.0.1:8787
* Next work: Windows binary, forecast validation (`docs/ROADMAP.md`)
* Private workbench at `.workbench/` (gitignored)

## Brand

* `quotacap` lowercase for binary/npm/repo/gh org
* `QuotaCap` display (like CrossRev / CopyDesk)
* Domain `quotacap.ai` available standard (~$80/yr), `.com` taken
