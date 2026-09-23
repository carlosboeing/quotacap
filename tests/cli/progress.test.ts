import { describe, expect, it, vi } from "vitest";
import {
  createPhase,
  formatPhase,
  phase,
  shouldEmitProgress,
} from "../../src/cli/progress.js";

describe("formatPhase", () => {
  it("appends ellipsis to plain phase message", () => {
    expect(formatPhase("waiting for daemon")).toBe("waiting for daemon…");
  });

  it("normalizes three dots to unicode ellipsis", () => {
    expect(formatPhase("downloading 0.0.41...")).toBe("downloading 0.0.41…");
  });

  it("preserves existing unicode ellipsis without duplicating", () => {
    expect(formatPhase("waiting for first readings…")).toBe("waiting for first readings…");
  });

  it("trims surrounding whitespace", () => {
    expect(formatPhase("  refreshing model catalogs  ")).toBe("refreshing model catalogs…");
  });

  it("returns empty string for empty input", () => {
    expect(formatPhase("")).toBe("");
    expect(formatPhase("   ")).toBe("");
  });
});

describe("shouldEmitProgress", () => {
  it("returns true only on interactive TTY when not quiet or json", () => {
    expect(shouldEmitProgress({ isTTY: true })).toBe(true);
    expect(shouldEmitProgress({ isTTY: true, json: true })).toBe(false);
    expect(shouldEmitProgress({ isTTY: true, quiet: true })).toBe(false);
    expect(shouldEmitProgress({ isTTY: false })).toBe(false);
  });

  it("falls back to process.stderr.isTTY when isTTY is omitted", () => {
    const desc = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    try {
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      expect(shouldEmitProgress()).toBe(true);
      expect(shouldEmitProgress({ json: true })).toBe(false);

      Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
      expect(shouldEmitProgress()).toBe(false);
    } finally {
      if (desc) Object.defineProperty(process.stderr, "isTTY", desc);
    }
  });
});

describe("phase", () => {
  it("emits strictly to stderr via custom writer when active", () => {
    const writer = vi.fn();
    phase("downloading 0.0.41", { isTTY: true, stderr: writer });
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith("downloading 0.0.41…");
  });

  it("suppresses output when json is true", () => {
    const writer = vi.fn();
    phase("waiting for daemon", { isTTY: true, json: true, stderr: writer });
    expect(writer).not.toHaveBeenCalled();
  });

  it("suppresses output when quiet is true", () => {
    const writer = vi.fn();
    phase("waiting for daemon", { isTTY: true, quiet: true, stderr: writer });
    expect(writer).not.toHaveBeenCalled();
  });

  it("suppresses output when non-interactive (not a TTY)", () => {
    const writer = vi.fn();
    phase("waiting for daemon", { isTTY: false, stderr: writer });
    expect(writer).not.toHaveBeenCalled();
  });

  it("suppresses output when message is empty or whitespace", () => {
    const writer = vi.fn();
    phase("   ", { isTTY: true, stderr: writer });
    expect(writer).not.toHaveBeenCalled();
  });

  it("defaults to console.error when no custom writer is provided", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      phase("waiting for daemon", { isTTY: true });
      expect(errSpy).toHaveBeenCalledWith("waiting for daemon…");
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("createPhase", () => {
  it("binds base options across multiple calls", () => {
    const writer = vi.fn();
    const p = createPhase({ isTTY: true, stderr: writer });

    p("waiting for daemon");
    p("waiting for first readings");

    expect(writer).toHaveBeenNthCalledWith(1, "waiting for daemon…");
    expect(writer).toHaveBeenNthCalledWith(2, "waiting for first readings…");
  });

  it("allows overriding base options per call", () => {
    const writer = vi.fn();
    const p = createPhase({ isTTY: true, stderr: writer });

    p("waiting for daemon", { quiet: true });
    expect(writer).not.toHaveBeenCalled();

    p("waiting for daemon");
    expect(writer).toHaveBeenCalledWith("waiting for daemon…");
  });
});
