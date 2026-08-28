import { execFileSync } from "node:child_process";

// Compiles the quotacap bun binary for one or more targets.
// Usage: node scripts/build-binary.mjs [bun-darwin-arm64 bun-linux-x64 ...]
// Default: current platform.

const requested = process.argv.slice(2);
const current = `bun-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const targets = requested.length ? requested : [current];

for (const t of targets) {
  const name = t.replace(/^bun-/, "");
  console.log(`building ${name} ...`);
  execFileSync(
    "bun",
    ["build", "--compile", "src/cli/index.ts", "--target", t, "--outfile", `dist-bin/quotacap-${name}`],
    { stdio: "inherit" },
  );
  console.log(`built dist-bin/quotacap-${name}`);
}