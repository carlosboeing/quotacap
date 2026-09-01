import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Compiles the quotacap bun binary for one or more targets.
// Usage: node scripts/build-binary.mjs [bun-darwin-arm64 bun-linux-x64 ...]
// Default: current platform.
// For each target, also stages a pty sidecar (node-pty prebuild) and creates
// a tarball quotacap-<os>-<arch>.tar.gz containing the binary + pty/ sidecar.

const requested = process.argv.slice(2);
const current = `bun-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const targets = requested.length ? requested : [current];

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else if (entry.isSymbolicLink()) {
      const link = fs.readlinkSync(s);
      fs.symlinkSync(link, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

for (const t of targets) {
  const name = t.replace(/^bun-/, ""); // e.g. darwin-arm64
  const binPath = `dist-bin/quotacap-${name}`;
  console.log(`building ${name} ...`);
  execFileSync(
    "bun",
    ["build", "--compile", "src/cli/index.ts", "--target", t, "--outfile", binPath],
    { stdio: "inherit" },
  );
  console.log(`built ${binPath}`);

  // Stage pty sidecar for this target
  const [os, arch] = name.split("-");
  const prebuildDir = `prebuilds/${os}-${arch}`;
  const srcPty = "node_modules/node-pty";
  if (!fs.existsSync(srcPty)) {
    console.warn(`skip pty sidecar for ${name}: ${srcPty} not found (optionalDependency not installed)`);
    continue;
  }
  if (!fs.existsSync(path.join(srcPty, prebuildDir))) {
    console.warn(`skip pty sidecar for ${name}: ${prebuildDir} not found in node-pty`);
    continue;
  }

  const sidecarRoot = `dist-bin/pty-${name}`;
  const destPty = path.join(sidecarRoot, "node-pty");
  // Clean previous
  fs.rmSync(sidecarRoot, { recursive: true, force: true });
  copyDirSync(srcPty, destPty);

  // Prune prebuilds to only this platform to keep archive small
  const prebuildsRoot = path.join(destPty, "prebuilds");
  if (fs.existsSync(prebuildsRoot)) {
    for (const entry of fs.readdirSync(prebuildsRoot)) {
      if (entry !== `${os}-${arch}`) {
        fs.rmSync(path.join(prebuildsRoot, entry), { recursive: true, force: true });
      }
    }
    // Ensure spawn-helper is executable
    const helper = path.join(prebuildsRoot, `${os}-${arch}`, "spawn-helper");
    if (fs.existsSync(helper)) {
      try { fs.chmodSync(helper, 0o755); } catch {}
    }
  }

  // Create tarball containing binary + sidecar
  const tarName = `quotacap-${name}.tar.gz`;
  const tarPath = `dist-bin/${tarName}`;
  // The tarball should contain: quotacap (binary) and pty/node-pty/
  // We use a temp staging dir to control archive layout
  const stageDir = `dist-bin/stage-${name}`;
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  fs.copyFileSync(binPath, path.join(stageDir, "quotacap"));
  // pty sidecar as pty/node-pty relative to binary
  const stagePty = path.join(stageDir, "pty", "node-pty");
  copyDirSync(destPty, stagePty);
  try { fs.chmodSync(path.join(stageDir, "quotacap"), 0o755); } catch {}

  console.log(`creating ${tarPath} ...`);
  execFileSync("tar", ["-czf", path.resolve(tarPath), "-C", path.resolve(stageDir), "quotacap", "pty"], { stdio: "inherit" });
  console.log(`created ${tarPath}`);

  // Also keep a plain pty directory alongside binary for local testing (dist-bin/pty/node-pty)
  const localPty = "dist-bin/pty/node-pty";
  fs.rmSync(localPty, { recursive: true, force: true });
  copyDirSync(destPty, localPty);
  try {
    const h = path.join(localPty, `prebuilds/${os}-${arch}/spawn-helper`);
    if (fs.existsSync(h)) fs.chmodSync(h, 0o755);
  } catch {}

  // Cleanup stage
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.rmSync(sidecarRoot, { recursive: true, force: true });

  console.log(`sidecar staged for ${name} at dist-bin/pty/node-pty (prebuild ${os}-${arch})`);
}
