import { describe, it, expect, afterEach } from "vitest";
import {
  adapters,
  pollAll,
  mapWithConcurrency,
  isRetryableChildFailure,
  computeRetryDelayMs,
  ADAPTER_TIMEOUTS,
} from "../../src/adapters/index.js";
import { clearAdapterSignal } from "../../src/runtime/spawn.js";

const testIds: string[] = [];
afterEach(() => {
  for (const id of testIds.splice(0)) {
    delete adapters[id];
    clearAdapterSignal(id);
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapWithConcurrency", () => {
  it("preserves input order", async () => {
    const out = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await sleep(ms);
      return ms;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it("caps concurrent executions", async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (v) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(30);
      active--;
      return v;
    });
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(1);
  });
});

describe("isRetryableChildFailure", () => {
  it("retries output problems", () => {
    expect(isRetryableChildFailure(new Error("grok: bad resets timestamp"))).toBe(true);
    expect(isRetryableChildFailure(new Error("codex: limits refresh requested"))).toBe(true);
    const dns = Object.assign(new Error("getaddrinfo ENOTFOUND api.kimi.ai"), { code: "ENOTFOUND" });
    expect(isRetryableChildFailure(dns)).toBe(true);
  });

  it("never retries walls, deaths, or child timeout text", () => {
    expect(isRetryableChildFailure(new Error("run grok login to continue"))).toBe(false);
    expect(isRetryableChildFailure(new Error("grok: command not found"))).toBe(false);
    expect(isRetryableChildFailure(new Error("pty: untrusted workspace"))).toBe(false);
    expect(isRetryableChildFailure(new Error("rate limit exceeded"))).toBe(false);
    expect(isRetryableChildFailure(new Error("Command failed: codex (code 1)"))).toBe(false);
    // Gate timeouts retry structurally; a child merely saying "timed out" is
    // not evidence our gate fired.
    expect(isRetryableChildFailure(new Error("Codex took too long: timed out"))).toBe(false);
  });
});

describe("pollAll resilience", () => {
  it("retries a parse failure once and fulfills", async () => {
    let calls = 0;
    adapters["test-flaky"] = {
      id: "test-flaky",
      requiresAuth: "none",
      async poll(): Promise<any> {
        calls++;
        if (calls === 1) throw new Error("test: bad resets timestamp");
        return { provider: "test-flaky" };
      },
    };
    testIds.push("test-flaky");
    const rows = await pollAll(["test-flaky"], { baseRetryDelayMs: 10 });
    expect(rows[0].status).toBe("fulfilled");
    expect(calls).toBe(2);
  });

  it("does not retry auth failures", async () => {
    let calls = 0;
    adapters["test-auth"] = {
      id: "test-auth",
      requiresAuth: "none",
      async poll(): Promise<any> {
        calls++;
        throw new Error("run test-auth login to continue");
      },
    };
    testIds.push("test-auth");
    const rows = await pollAll(["test-auth"], { baseRetryDelayMs: 10 });
    expect(rows[0].status).toBe("rejected");
    expect(calls).toBe(1);
  });

  it("retries gate timeouts and reports the last timeout", async () => {
    let calls = 0;
    adapters["test-hang"] = {
      id: "test-hang",
      requiresAuth: "none",
      async poll(): Promise<any> {
        calls++;
        await sleep(5000);
        return { provider: "test-hang" };
      },
    };
    testIds.push("test-hang");
    const rows = await pollAll(["test-hang"], {
      timeouts: { "test-hang": 80 },
      baseRetryDelayMs: 10,
    });
    expect(rows[0].status).toBe("rejected");
    expect(calls).toBe(3);
    expect(String((rows[0] as any).reason?.message ?? "")).toMatch(/timeout after 80ms/);
  });

  it("maxAttempts: 1 disables retry", async () => {
    let calls = 0;
    adapters["test-once"] = {
      id: "test-once",
      requiresAuth: "none",
      async poll(): Promise<any> {
        calls++;
        throw new Error("test: bad resets timestamp");
      },
    };
    testIds.push("test-once");
    const rows = await pollAll(["test-once"], { maxAttempts: 1, baseRetryDelayMs: 10 });
    expect(rows[0].status).toBe("rejected");
    expect(calls).toBe(1);
  });

  it("an aborted signal starts no retry", async () => {
    let calls = 0;
    adapters["test-abort"] = {
      id: "test-abort",
      requiresAuth: "none",
      async poll(): Promise<any> {
        calls++;
        throw new Error("test: bad resets timestamp");
      },
    };
    testIds.push("test-abort");
    const controller = new AbortController();
    controller.abort();
    const rows = await pollAll(["test-abort"], { baseRetryDelayMs: 10, signal: controller.signal });
    expect(rows[0].status).toBe("rejected");
    expect(calls).toBe(1);
  });

  it("caps concurrency and keeps enabled order", async () => {
    let active = 0;
    let maxActive = 0;
    for (const [id, ms] of [["test-c1", 120], ["test-c2", 10], ["test-c3", 10]] as const) {
      adapters[id] = {
        id,
        requiresAuth: "none",
        async poll(): Promise<any> {
          active++;
          maxActive = Math.max(maxActive, active);
          await sleep(ms);
          active--;
          return { provider: id };
        },
      };
      testIds.push(id);
    }
    const rows = await pollAll(["test-c1", "test-c2", "test-c3"], { maxConcurrency: 2 });
    expect(rows.map((r) => r.provider)).toEqual(["test-c1", "test-c2", "test-c3"]);
    expect(rows.every((r) => r.status === "fulfilled")).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

describe("computeRetryDelayMs", () => {
  it("grows exponentially with equal jitter", () => {
    // rng 0 pins the low edge (half), ~1 pins the high edge (full).
    expect(computeRetryDelayMs(1, 2000, 8000, () => 0)).toBe(1000);
    expect(computeRetryDelayMs(2, 2000, 8000, () => 0)).toBe(2000);
    expect(computeRetryDelayMs(1, 2000, 8000, () => 0.999)).toBe(1999);
    expect(computeRetryDelayMs(2, 2000, 8000, () => 0.999)).toBe(3998);
  });

  it("honours the cap", () => {
    expect(computeRetryDelayMs(9, 2000, 8000, () => 0.999)).toBeLessThanOrEqual(8000);
    expect(computeRetryDelayMs(9, 2000, 8000, () => 0)).toBe(4000);
  });

  it("stays in range with the default rng", () => {
    for (let i = 0; i < 50; i++) {
      const d = computeRetryDelayMs(2, 2000, 8000);
      expect(d).toBeGreaterThanOrEqual(2000);
      expect(d).toBeLessThanOrEqual(4000);
    }
  });
});

describe("pollAll default attempts", () => {
  it("tries three times by default", async () => {
    let calls = 0;
    adapters["test-always"] = {
      id: "test-always",
      requiresAuth: "none",
      async poll(): Promise<any> {
        calls++;
        throw new Error("test: bad resets timestamp");
      },
    };
    testIds.push("test-always");
    const rows = await pollAll(["test-always"], { baseRetryDelayMs: 5 });
    expect(rows[0].status).toBe("rejected");
    expect(calls).toBe(3);
  });
});

describe("ADAPTER_TIMEOUTS", () => {
  it("gives claude 15s headroom over measured 2-4.4s cold starts", () => {
    expect(ADAPTER_TIMEOUTS.claude).toBe(15000);
  });
});
