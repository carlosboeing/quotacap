# Contributing to QuotaCap

Thank you for contributing to QuotaCap. QuotaCap is an open-source, local quota tracker for AI coding subscriptions with a dashboard, CLI, and MCP server.

## Code of conduct

This project adheres to the Contributor Covenant [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Security disclosures

If you discover a security vulnerability, please do **not** open a public issue or pull request. Refer to [SECURITY.md](SECURITY.md) for instructions on private reporting via email or GitHub Private Security Advisories.

## Development setup

### Prerequisites

- Node.js >= 22.13.0
- Bun >= 1.3.0 (for Bun runtime tests and standalone binary builds)
- npm >= 10.0.0

### Getting started

1. Clone the repository:
   ```bash
   git clone https://github.com/carlosboeing/quotacap.git
   cd quotacap
   ```

2. Install dependencies:
   ```bash
   npm ci
   ```

3. Build the project (Vite dashboard + embedded assets + TypeScript):
   ```bash
   npm run build
   ```

4. Run the test suite:
   ```bash
   npm test
   bun test tests/bun/
   ```

5. Run the CLI from source:
   ```bash
   npm run cli -- status
   ```

### Local development loop

One command runs the backend daemon (auto-restarts on `src` changes) plus the dashboard with hot reload:

```bash
quotacap service stop   # once: the login service owns port 8787
npm run dev             # daemon on :8787, dashboard with HMR on :5173
```

Open http://localhost:5173 — the Vite server proxies `/api/*` to the daemon. Add `-- --open` (`npm run dev -- --open`) to open it automatically once Vite is up; `QUOTACAP_NO_OPEN=1` vetoes the open. Ctrl-C stops both; `quotacap service start` restores the login service afterwards.

Granular scripts: `npm run dev:daemon` (backend only), `npm run dev:web` (dashboard HMR only, needs a daemon on 8787), `npm start` (production-like: full build, then the compiled daemon with no watchers). If the daemon binds a non-default port, point the proxy at it: `QUOTACAP_DEV_API=http://127.0.0.1:<port> npm run dev:web`.

## Contribution guidelines

### Workflow and branches

- Branch off `origin/main`.
- Keep changes surgical and focused on a single concern.
- Ensure all tests and typechecks pass before submitting a pull request.

### Conventional Commits

We enforce Conventional Commits for commit messages:
`<type>(<scope>): <description>`

- **Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`
- Keep the subject line under 72 characters and written in the imperative mood.
- Body explains *why* the change is made.

### Pull requests

- Open a pull request against `main`.
- Follow the pull request template provided in `.github/pull_request_template.md`.
- All pull requests must pass the automated `required` CI check on GitHub Actions.
- Maintain linear history (PRs are squash-merged).
