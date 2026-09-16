import { describe, it, expect, vi } from "vitest";
import * as pty from "../../src/adapters/pty.js";
import { museCatalogFetcher, MUSE_OVERALL_MS } from "../../src/catalog/muse.js";

describe("museCatalogFetcher wrapper", () => {
  it("passes exact phase options, completionRegex without muse-spark-, and MUSE_OVERALL_MS signal", async () => {
    let capturedOpts: any = null;
    vi.spyOn(pty, "runPty").mockImplementation(async (opts) => {
      capturedOpts = opts;
      return (
        "Muse Code 2.1 · High Usage · muse-spark-1.3·max\n\n> /model\n\nChoose model\n" +
        "  ❯ muse-spark-1.3\n    muse-spark-1.3-contributor\n    muse-spark-1.2\n    muse-spark-1.2-contributor\n"
      );
    });

    const result = await museCatalogFetcher.fetch();
    expect(result.muse).toHaveLength(4);
    expect(result.muse.map((m) => m.id)).toEqual([
      "muse-spark-1.3",
      "muse-spark-1.3-contributor",
      "muse-spark-1.2",
      "muse-spark-1.2-contributor",
    ]);

    expect(capturedOpts).toBeDefined();
    expect(capturedOpts.file).toBe("muse");
    expect(capturedOpts.readyTimeoutMs).toBe(8000);
    expect(capturedOpts.settleDelayMs).toBe(1000);
    expect(capturedOpts.submitAfterMs).toBe(1500);
    expect(capturedOpts.timeoutMs).toBe(14000);

    // completionRegex must match "Choose model" and NOT "muse-spark-"
    expect(capturedOpts.completionRegex).toBeDefined();
    expect(capturedOpts.completionRegex.source).toMatch(/Choose\\s\*model/);
    expect(capturedOpts.completionRegex.source).not.toMatch(/muse-spark-/);

    // signal aborts at MUSE_OVERALL_MS (28000)
    expect(MUSE_OVERALL_MS).toBe(28_000);
    expect(capturedOpts.signal).toBeDefined();
    expect(capturedOpts.signal instanceof AbortSignal).toBe(true);
  });

  it("propagates abort error if runPty aborts on signal timeout", async () => {
    vi.spyOn(pty, "runPty").mockImplementation(async (opts) => {
      if (opts.signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      return new Promise((_, reject) => {
        opts.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
        // Immediately abort for test
        throw new DOMException("The operation was aborted", "AbortError");
      });
    });

    await expect(museCatalogFetcher.fetch()).rejects.toThrow();
  });
});
