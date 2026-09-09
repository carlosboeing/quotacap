#!/usr/bin/env node
// Minimal claim holder for ownership process tests (tests/runtime, tests/bun).
// Prints HELD on success, CONTENDED:<nonce> when another owner holds the lock.
// Runs under both node and bun; loads the built owner module, so tests that
// spawn this helper require `npm run build` first (same as tests/daemon.test.ts).
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ownerPath = path.resolve(here, "../../../dist/runtime/owner.js");
let owner;
try {
  owner = await import(ownerPath);
} catch (e) {
  console.error(`claim-holder: cannot load ${ownerPath} — run npm run build first`);
  process.exit(2);
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}

const dir = arg("dir", null);
const holdMs = parseInt(arg("hold-ms", "1000"), 10);
if (!dir) {
  console.error("claim-holder: --dir required");
  process.exit(2);
}

const opts = {};
for (const [flag, key] of [["beat-ms", "beatIntervalMs"], ["stale-ms", "staleMs"], ["grace-ms", "graceMs"]]) {
  const v = arg(flag, null);
  if (v !== null) opts[key] = parseInt(v, 10);
}

let claim;
try {
  claim = await owner.acquireClaim(dir, opts);
} catch (e) {
  if (e && e.name === "AlreadyRunningError") {
    console.log(`CONTENDED:${e.holder?.nonce ?? "unknown"}`);
    process.exit(1);
  }
  throw e;
}
console.log("HELD");
await new Promise((r) => setTimeout(r, holdMs));
claim.release();
process.exit(0);
