import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  repairSpawnHelpers,
  describeSpawnHelperRepairs,
} from "../../src/adapters/pty.js";

function makeRoot(entries: Record<string, boolean>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qc-pty-perms-"));
  for (const [entry, withHelper] of Object.entries(entries)) {
    const dir = path.join(root, "prebuilds", entry);
    fs.mkdirSync(dir, { recursive: true });
    if (withHelper) {
      const helper = path.join(dir, "spawn-helper");
      fs.writeFileSync(helper, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(helper, 0o644);
    }
  }
  return root;
}

function modeOf(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

describe("repairSpawnHelpers", () => {
  it("restores +x on every prebuilds entry helper", () => {
    const root = makeRoot({ "darwin-arm64": true, "linux-x64": true });
    const outcomes = repairSpawnHelpers([root]);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    for (const o of outcomes) {
      expect(modeOf(o.helper) & 0o111).toBe(0o111);
    }
  });

  it("skips missing prebuild dirs, missing helpers, and duplicate roots silently", () => {
    const root = makeRoot({ "darwin-arm64": true, "win32-x64": false });
    const missing = path.join(root, "no-such-root");
    const outcomes = repairSpawnHelpers([root, root, missing]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].ok).toBe(true);
    expect(outcomes[0].helper).toContain("darwin-arm64");
  });

  it("records chmod failures instead of throwing", () => {
    const root = makeRoot({ "darwin-arm64": true });
    const outcomes = repairSpawnHelpers([root], () => {
      throw new Error("EPERM: operation not permitted, chmod");
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].error).toMatch(/EPERM/);
  });

  it("repairs the real installed node-pty root without failures", () => {
    const require = createRequire(import.meta.url);
    const pkgJson: string = require.resolve("node-pty/package.json");
    const outcomes = repairSpawnHelpers([path.dirname(pkgJson)]);
    // Whatever helpers ship on this platform must all repair cleanly.
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(describeSpawnHelperRepairs(outcomes)).toBeNull();
  });
});

describe("describeSpawnHelperRepairs", () => {
  it("returns null when nothing failed", () => {
    expect(describeSpawnHelperRepairs([])).toBeNull();
    expect(
      describeSpawnHelperRepairs([{ helper: "/x/spawn-helper", ok: true }]),
    ).toBeNull();
  });

  it("names every failed helper plus the ownership remedy", () => {
    const msg = describeSpawnHelperRepairs([
      { helper: "/a/prebuilds/darwin-arm64/spawn-helper", ok: false, error: "EPERM: operation not permitted" },
      { helper: "/a/prebuilds/linux-x64/spawn-helper", ok: true },
      { helper: "/b/prebuilds/darwin-arm64/spawn-helper", ok: false, error: "EACCES: permission denied" },
    ]);
    expect(msg).toContain("/a/prebuilds/darwin-arm64/spawn-helper");
    expect(msg).toContain("EPERM");
    expect(msg).toContain("/b/prebuilds/darwin-arm64/spawn-helper");
    expect(msg).toContain("EACCES");
    expect(msg).toMatch(/root-owned|sudo/i);
    expect(msg).toMatch(/reinstall without sudo/i);
  });
});
