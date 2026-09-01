# Changelog

## 0.0.21

- Provider adapter: Antigravity (`agy`) — headless `agy -p /usage --output-format json`, extracts Gemini weekly bucket and 5h session window, fail-closed error handling; `enabledProviders` defaults to claude, codex, kimi, grok, agy

## 0.0.20

- npm metadata: `description`, `license: MIT`, `keywords`, `bugs` (replaces the old README-extract listing)
- Public README: visitor intro, Features, live vs paste providers, estimate not a leftover-quota guarantee

## 0.0.19

- Provider adapters: codex (wham/usage), kimi (coding/v1/usages), grok (cli-chat-proxy billing) — reuses each CLI's OAuth session, zero API keys; `enabledProviders` defaults to claude, codex, kimi, grok
- Adapter core: OAuth refresh on expiry with rotated pairs persisted in place, cross-process lock, unique temp names, `0600` modes preserved
- Burn-rate history and advisory unchanged; new adapters feed the same dashboard, CLI, and MCP tables
- Docs: `docs/architecture.md` (components, system diagram, commands, data model, security model)
