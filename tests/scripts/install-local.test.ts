import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getTargetName,
  getBinDir,
  resolveLocalVersion,
  installBinary,
  reloadServiceIfRunning,
} from "../../scripts/install-local.mjs";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("install-local script", () => {
  describe("getTargetName", () => {
    it("resolves darwin architectures correctly", () => {
      expect(getTargetName("darwin", "arm64")).toBe("darwin-arm64");
      expect(getTargetName("darwin", "x64")).toBe("darwin-x64");
    });

    it("resolves linux architectures correctly", () => {
      expect(getTargetName("linux", "arm64")).toBe("linux-arm64");
      expect(getTargetName("linux", "aarch64")).toBe("linux-arm64");
      expect(getTargetName("linux", "x64")).toBe("linux-x64");
      expect(getTargetName("linux", "x86_64")).toBe("linux-x64");
    });

    it("throws a descriptive error on unsupported platforms", () => {
      expect(() => getTargetName("win32", "x64")).toThrow(
        /unsupported platform: win32/i,
      );
    });
  });

  describe("getBinDir", () => {
    it("honors QUOTACAP_BIN_DIR when set", () => {
      const custom = "/custom/bin/dir";
      expect(getBinDir({ QUOTACAP_BIN_DIR: custom })).toBe(custom);
    });

    it("defaults to ~/.local/bin when unset", () => {
      const expected = path.join(os.homedir(), ".local", "bin");
      expect(getBinDir({})).toBe(expected);
    });
  });

  describe("resolveLocalVersion", () => {
    it("resolves version with git short sha when clean", () => {
      const execMock = (_cmd: string, args: string[]) => {
        if (args.includes("HEAD")) return "6ffb4f9\n";
        if (args.includes("--porcelain")) return "";
        return "";
      };
      const version = resolveLocalVersion(execMock as any);
      expect(version).toMatch(/^0\.0\.\d+-6ffb4f9$/);
    });

    it("appends -dirty when uncommitted changes exist", () => {
      const execMock = (_cmd: string, args: string[]) => {
        if (args.includes("HEAD")) return "6ffb4f9\n";
        if (args.includes("--porcelain")) return " M somefile.ts\n";
        return "";
      };
      const version = resolveLocalVersion(execMock as any);
      expect(version).toMatch(/^0\.0\.\d+-6ffb4f9-dirty$/);
    });

    it("falls back to package.json version if git throws", () => {
      const execMock = () => {
        throw new Error("not a git repository");
      };
      const version = resolveLocalVersion(execMock as any);
      expect(version).toMatch(/^0\.0\.\d+$/);
    });
  });

  describe("installBinary", () => {
    it("throws if source binary does not exist", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qc-install-test-"));
      try {
        expect(() =>
          installBinary({
            binDir: tmpDir,
            sourceBin: path.join(tmpDir, "non-existent-binary"),
          }),
        ).toThrow(/source binary not found/i);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("installs binary with 0o755 permissions and creates binDir if missing", () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qc-install-test-"));
      const binDir = path.join(tmpRoot, "nested", "bin");
      const srcBin = path.join(tmpRoot, "mock-quotacap");
      fs.writeFileSync(srcBin, "#!/bin/sh\necho ok\n");

      try {
        const result = installBinary({ binDir, sourceBin: srcBin });
        const targetBin = path.join(binDir, "quotacap");

        expect(result.installedBin).toBe(targetBin);
        expect(fs.existsSync(targetBin)).toBe(true);
        expect(fs.readFileSync(targetBin, "utf-8")).toBe("#!/bin/sh\necho ok\n");

        const stat = fs.statSync(targetBin);
        // Ensure user executable bit is set
        expect((stat.mode & 0o111) !== 0).toBe(true);
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it("copies pty sidecar when present", () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qc-install-test-"));
      const binDir = path.join(tmpRoot, "bin");
      const srcBin = path.join(tmpRoot, "mock-quotacap");
      const srcPty = path.join(tmpRoot, "pty", "node-pty");
      fs.writeFileSync(srcBin, "mock-binary");
      fs.mkdirSync(srcPty, { recursive: true });
      fs.writeFileSync(path.join(srcPty, "sidecar.txt"), "pty-content");

      try {
        const result = installBinary({
          binDir,
          sourceBin: srcBin,
          sourcePty: path.join(tmpRoot, "pty"),
        });

        const targetPty = path.join(binDir, "pty", "node-pty", "sidecar.txt");
        expect(result.installedPty).toBe(path.join(binDir, "pty"));
        expect(fs.existsSync(targetPty)).toBe(true);
        expect(fs.readFileSync(targetPty, "utf-8")).toBe("pty-content");
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  });

  describe("reloadServiceIfRunning", () => {
    it("restarts service and returns true when service is running/loaded", () => {
      const calls: { cmd: string; args: string[] }[] = [];
      const execMock = (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        if (args.includes("status")) {
          return Buffer.from("Registration: installed and loaded (active)");
        }
        return Buffer.from("Service restarted");
      };

      const reloaded = reloadServiceIfRunning("/path/to/quotacap", execMock as any);
      expect(reloaded).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0].args).toEqual(["service", "status"]);
      expect(calls[1].args).toEqual(["service", "restart"]);
    });

    it("returns false without restarting when service is not loaded", () => {
      const calls: { cmd: string; args: string[] }[] = [];
      const execMock = (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return Buffer.from("Registration: installed but not loaded — run 'quotacap service start'");
      };

      const reloaded = reloadServiceIfRunning("/path/to/quotacap", execMock as any);
      expect(reloaded).toBe(false);
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual(["service", "status"]);
    });

    it("returns false gracefully if status probe throws", () => {
      const execMock = () => {
        throw new Error("command not found");
      };

      const reloaded = reloadServiceIfRunning("/path/to/quotacap", execMock as any);
      expect(reloaded).toBe(false);
    });
  });
});
