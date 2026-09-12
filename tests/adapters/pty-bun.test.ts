import { describe, it, expect, vi, afterEach } from "vitest";
import { runPty } from "../../src/adapters/pty.js";

describe("runPtyBun mocked checkpoint diagnostics and cleanup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setupMockBun(options?: {
    terminal?: boolean | { writeThrows?: boolean };
    exitCode?: number;
    exitDelayMs?: number;
    feedData?: (send: (chunk: string) => void) => void;
    onWrite?: (input: string) => void;
  }) {
    const closeSpy = vi.fn();
    const writeSpy = vi.fn((input: string) => {
      if (typeof options?.terminal === "object" && options.terminal.writeThrows) {
        throw new Error("mock terminal write broken");
      }
      if (options?.onWrite) {
        options.onWrite(input);
      }
    });
    const killSpy = vi.fn();

    let dataCb: ((term: any, chunk: any) => void) | undefined;
    let exitedResolve: (code: number) => void;
    const exitedPromise = new Promise<number>((r) => {
      exitedResolve = r;
    });

    if (options?.exitDelayMs !== undefined) {
      setTimeout(() => {
        exitedResolve(options.exitCode ?? 0);
      }, options.exitDelayMs);
    }

    const mockSpawn = vi.fn((cmd: string[], spawnOpts: any) => {
      dataCb = spawnOpts?.terminal?.data;
      if (options?.feedData && dataCb) {
        options.feedData((chunk: string) => {
          dataCb!({}, chunk);
        });
      }
      return {
        terminal:
          options?.terminal === false
            ? undefined
            : {
                write: writeSpy,
                close: closeSpy,
              },
        exited: exitedPromise,
        kill: killSpy,
      };
    });

    vi.stubGlobal("Bun", {
      spawn: mockSpawn,
    });

    return {
      closeSpy,
      writeSpy,
      killSpy,
      sendData: (chunk: string) => dataCb?.({}, chunk),
      resolveExit: (code: number) => exitedResolve(code),
    };
  }

  it("absent-terminal guard fails loud with terminal_error and DiagnosticError", async () => {
    setupMockBun({ terminal: false });
    await expect(
      runPty({
        file: "dummy",
        input: "/check\r",
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      name: "DiagnosticError",
      diagnostic: {
        diagnosticCode: "terminal_error",
        errorDetail: expect.stringContaining("lacks terminal (PTY) support"),
      },
    });
  });

  it("checkpoint before ready: premature exit rejects with DiagnosticError and closes terminal", async () => {
    const { closeSpy } = setupMockBun({
      exitCode: 1,
      exitDelayMs: 20,
    });
    await expect(
      runPty({
        file: "dummy",
        input: "/check\r",
        readyRegex: /READY/,
        readyTimeoutMs: 1000,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      name: "DiagnosticError",
      diagnostic: {
        diagnosticCode: "unknown",
        errorDetail: expect.stringContaining("before ready"),
      },
    });
    expect(closeSpy).toHaveBeenCalled();
  });

  it("checkpoint ready timeout: times out, closes terminal, rejects DiagnosticError timeout", async () => {
    const { closeSpy } = setupMockBun();
    await expect(
      runPty({
        file: "dummy",
        input: "/check\r",
        readyRegex: /READY/,
        readyTimeoutMs: 100,
        timeoutMs: 500,
      }),
    ).rejects.toMatchObject({
      name: "DiagnosticError",
      diagnostic: {
        diagnosticCode: "timeout",
        errorDetail: expect.stringContaining("ready timeout"),
      },
    });
    expect(closeSpy).toHaveBeenCalled();
  });

  it("checkpoint during settle: premature exit rejects with DiagnosticError and closes terminal", async () => {
    const { closeSpy } = setupMockBun({
      exitCode: 1,
      exitDelayMs: 20,
    });
    await expect(
      runPty({
        file: "dummy",
        input: "/check\r",
        settleDelayMs: 100,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      name: "DiagnosticError",
      diagnostic: {
        diagnosticCode: "unknown",
        errorDetail: expect.stringContaining("during settle"),
      },
    });
    expect(closeSpy).toHaveBeenCalled();
  });

  it("checkpoint write failure: rejects DiagnosticError and closes terminal", async () => {
    const { closeSpy } = setupMockBun({
      terminal: { writeThrows: true },
      feedData: (send) => send("READY\n"),
    });
    await expect(
      runPty({
        file: "dummy",
        input: "/check\r",
        readyRegex: /READY/,
        readyTimeoutMs: 1000,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      name: "DiagnosticError",
      diagnostic: {
        errorDetail: expect.stringContaining("write failed"),
      },
    });
    expect(closeSpy).toHaveBeenCalled();
  });

  it("checkpoint before completion: premature exit rejects DiagnosticError and closes terminal", async () => {
    let doExit: () => void = () => {};
    const { closeSpy, resolveExit } = setupMockBun({
      feedData: (send) => send("READY\n"),
      onWrite: () => {
        setTimeout(() => resolveExit(2), 20);
      },
    });
    await expect(
      runPty({
        file: "dummy",
        input: "/check\r",
        readyRegex: /READY/,
        readyTimeoutMs: 1000,
        completionRegex: /COMPLETED/,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      name: "DiagnosticError",
      diagnostic: {
        diagnosticCode: "unknown",
        errorDetail: expect.stringContaining("before completion"),
      },
    });
    expect(closeSpy).toHaveBeenCalled();
  });

  it("checkpoint completion timeout: times out, closes terminal, rejects DiagnosticError timeout", async () => {
    const { closeSpy } = setupMockBun({
      feedData: (send) => send("READY\n"),
    });
    await expect(
      runPty({
        file: "dummy",
        input: "/check\r",
        readyRegex: /READY/,
        readyTimeoutMs: 1000,
        completionRegex: /COMPLETED/,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({
      name: "DiagnosticError",
      diagnostic: {
        diagnosticCode: "timeout",
        errorDetail: expect.stringContaining("completion timeout"),
      },
    });
    expect(closeSpy).toHaveBeenCalled();
  });

  it("checkpoint transcript overflow: rejects DiagnosticError and closes terminal", async () => {
    const { closeSpy } = setupMockBun({
      feedData: (send) => send("x".repeat(2000)),
    });
    await expect(
      runPty({
        file: "dummy",
        input: "/check\r",
        readyRegex: /READY/,
        readyTimeoutMs: 1000,
        timeoutMs: 1000,
        maxBytes: 1000,
      }),
    ).rejects.toMatchObject({
      name: "DiagnosticError",
      diagnostic: {
        errorDetail: expect.stringContaining("transcript exceeds"),
      },
    });
    expect(closeSpy).toHaveBeenCalled();
  });

  it("checkpoint trust prompt: rejects DiagnosticError trust_prompt and closes terminal", async () => {
    const { closeSpy } = setupMockBun({
      feedData: (send) => send("Trust this folder?\n"),
    });
    await expect(
      runPty({
        file: "dummy",
        input: "/check\r",
        abortOn: /Trust this folder\?/i,
        readyRegex: /READY/,
        readyTimeoutMs: 1000,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      name: "DiagnosticError",
      diagnostic: {
        diagnosticCode: "trust_prompt",
        errorDetail: expect.stringContaining("untrusted workspace"),
      },
    });
    expect(closeSpy).toHaveBeenCalled();
  });
});
