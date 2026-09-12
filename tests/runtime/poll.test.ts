import { describe, it, expect, afterEach, vi } from "vitest";
import { openDb, migrate } from "../../src/store/db.js";
import { getLatestByProvider } from "../../src/store/quotas.js";
import { getAttempt, getAttempts, recordAttempt } from "../../src/store/attempts.js";
import {
  createCoordinator,
  ServiceClosing,
  type Coordinator,
} from "../../src/runtime/poll.js";

const coords: Coordinator[] = [];

afterEach(() => {
  for (const c of coords.splice(0)) {
    try {
      c.stop();
    } catch {}
  }
  vi.restoreAllMocks();
});

function track(c: Coordinator): Coordinator {
  coords.push(c);
  return c;
}

function freshDb(): any {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function makeClock(startMs: number) {
  let t = startMs;
  return {
    now: () => t,
    set: (ms: number) => {
      t = ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const T0 = Date.UTC(2026, 8, 9, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeQuota(provider: string, usedPct: number, nowMs: number): any {
  return {
    provider,
    plan: "test",
    usedPct,
    resetsAt: iso(nowMs + 7 * 86400000),
    periodStart: iso(nowMs - 7 * 86400000),
    source: "cli",
    fetchedAt: iso(nowMs),
  };
}

describe("poll coordinator", () => {
  it("(a) concurrent refresh shares one poll generation", async () => {
    const db = freshDb();
    const clock = makeClock(T0);
    let calls = 0;
    const coord = track(
      createCoordinator({
        db,
        enabledProviders: ["claude"],
        now: clock.now,
        pollFn: async () => {
          calls++;
          await sleep(50);
          return [
            {
              provider: "claude",
              status: "fulfilled",
              value: fakeQuota("claude", 10, clock.now()),
            },
          ];
        },
      }),
    );
    const [r1, r2] = await Promise.all([coord.refresh(), coord.refresh()]);
    expect(calls).toBe(1);
    expect(r1.shared).toBe(false);
    expect(r1.cooldown).toBe(false);
    expect(r2.shared).toBe(true);
    expect(r1.lastPollAt).toBe(r2.lastPollAt);
    expect(r2.fulfilled).toHaveLength(1);
  });

  it("(b) refresh inside the cooldown returns the cached result", async () => {
    const db = freshDb();
    const clock = makeClock(T0);
    let calls = 0;
    const coord = track(
      createCoordinator({
        db,
        enabledProviders: ["claude"],
        now: clock.now,
        pollFn: async () => {
          calls++;
          return [
            {
              provider: "claude",
              status: "fulfilled",
              value: fakeQuota("claude", 10, clock.now()),
            },
          ];
        },
      }),
    );
    const first = await coord.refresh();
    expect(calls).toBe(1);
    expect(coord.getState().polling).toBe("cooldown");

    clock.advance(10_000);
    const cached = await coord.refresh();
    expect(calls).toBe(1);
    expect(cached.cooldown).toBe(true);
    expect(cached.shared).toBe(false);
    expect(cached.lastPollAt).toBe(first.lastPollAt);

    clock.advance(61_000);
    expect(coord.getState().polling).toBe("idle");
    const fresh = await coord.refresh();
    expect(calls).toBe(2);
    expect(fresh.cooldown).toBe(false);
    expect(fresh.lastPollAt).toBe(iso(T0 + 71_000));
  });

  it("(c) schedule-next-after-completion never overlaps polls", async () => {
    const db = freshDb();
    let calls = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const coord = track(
      createCoordinator({
        db,
        enabledProviders: ["x"],
        pollFn: async () => {
          calls++;
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await sleep(80);
          concurrent--;
          return [];
        },
      }),
    );
    coord.start(30);
    await sleep(400);
    coord.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(maxConcurrent).toBe(1);
  });

  it("(d) overdue tick runs exactly one poll then resumes schedule", async () => {
    const db = freshDb();
    const clock = makeClock(T0);
    let calls = 0;
    const coord = track(
      createCoordinator({
        db,
        enabledProviders: ["claude"],
        now: clock.now,
        pollFn: async () => {
          calls++;
          return [
            {
              provider: "claude",
              status: "fulfilled",
              value: fakeQuota("claude", 10, clock.now()),
            },
          ];
        },
      }),
    );
    await coord.refresh();
    expect(calls).toBe(1);
    // Simulated wake: far past many intervals — still one poll, no burst.
    clock.advance(3600_000);
    await coord.scheduledTick();
    expect(calls).toBe(2);
    clock.advance(3600_000);
    await coord.scheduledTick();
    expect(calls).toBe(3);
    // Schedule resumes on the live timer.
    coord.start(40);
    await sleep(150);
    coord.stop();
    expect(calls).toBeGreaterThanOrEqual(4);
  });

  it("(e) partial success stores good rows and records attempts", async () => {
    const db = freshDb();
    const clock = makeClock(T0);
    recordAttempt(db, {
      provider: "codex",
      attemptedAt: iso(T0 - 1000),
      completedAt: iso(T0 - 1000),
      succeededAt: iso(T0 - 1000),
      success: true,
      failureCategory: null,
    });
    const coord = track(
      createCoordinator({
        db,
        enabledProviders: ["claude", "codex"],
        now: clock.now,
        pollFn: async () => {
          clock.advance(5000);
          return [
            {
              provider: "claude",
              status: "fulfilled",
              value: fakeQuota("claude", 25, clock.now()),
            },
            {
              provider: "codex",
              status: "rejected",
              reason: new Error("timeout after 12000ms"),
            },
          ];
        },
      }),
    );
    const r = await coord.refresh();
    expect(r.fulfilled).toHaveLength(1);
    expect(r.rejected).toHaveLength(1);
    expect(r.degraded).toBe(true);
    expect(getLatestByProvider(db, "claude")?.usedPct).toBe(25);

    const aClaude = getAttempt(db, "claude")!;
    expect(aClaude.success).toBe(true);
    expect(aClaude.attemptedAt).toBe(iso(T0));
    expect(aClaude.completedAt).toBe(iso(T0 + 5000));
    expect(aClaude.succeededAt).toBe(iso(T0 + 5000));
    expect(aClaude.failureCategory).toBeNull();

    const aCodex = getAttempt(db, "codex")!;
    expect(aCodex.success).toBe(false);
    expect(aCodex.attemptedAt).toBe(iso(T0));
    expect(aCodex.completedAt).toBe(iso(T0 + 5000));
    expect(aCodex.succeededAt).toBe(iso(T0 - 1000));
    expect(aCodex.failureCategory).toBe("timeout");
  });

  it("(f) manual id records skipped, never failure", async () => {
    const db = freshDb();
    const clock = makeClock(T0);
    const coord = track(
      createCoordinator({
        db,
        enabledProviders: ["manual"],
        now: clock.now,
        pollFn: async () => [
          {
            provider: "manual",
            status: "skipped",
            reason: new Error("manual skipped"),
          },
        ],
      }),
    );
    const r = await coord.refresh();
    expect(r.degraded).toBe(false);
    const a = getAttempt(db, "manual")!;
    expect(a.success).toBe(true);
    expect(a.failureCategory).toBe("skipped");
    expect(a.succeededAt).toBeNull();
  });

  it("(g) rejections map to the right failure category", async () => {
    const db = freshDb();
    const clock = makeClock(T0);
    const abortErr = new Error("operation aborted");
    abortErr.name = "AbortError";
    const matrix: [string, unknown, string][] = [
      ["p-timeout", new Error("timeout after 8000ms"), "timeout"],
      ["p-abort", new Error("pty aborted"), "timeout"],
      ["p-abortname", abortErr, "timeout"],
      ["p-auth1", new Error("run codex login to continue"), "auth"],
      ["p-auth2", new Error("401 unauthorized"), "auth"],
      ["p-auth3", new Error("403 forbidden"), "auth"],
      ["p-auth4", new Error("missing credential file"), "auth"],
      ["p-parse1", new SyntaxError("Unexpected token < in JSON"), "parse"],
      ["p-parse2", new Error("parse error: weekly limit not found"), "parse"],
      ["p-net1", new Error("getaddrinfo ENOTFOUND api.example.com"), "network"],
      ["p-net2", new Error("connect ECONNREFUSED 127.0.0.1:1"), "network"],
      ["p-net3", new Error("fetch failed"), "network"],
      ["p-net4", new Error("connect EAI_AGAIN registry"), "network"],
      ["p-unknown", new Error("something completely unexpected"), "unknown"],
    ];
    for (const [provider, reason, category] of matrix) {
      const coord = track(
        createCoordinator({
          db,
          enabledProviders: [provider],
          now: clock.now,
          pollFn: async () => [{ provider, status: "rejected", reason }],
        }),
      );
      const r = await coord.refresh();
      expect(r.degraded).toBe(true);
      expect(getAttempt(db, provider)?.failureCategory).toBe(category);
      expect(getAttempt(db, provider)?.success).toBe(false);
    }
  });

  it("(h) setClosing rejects new refresh and blocks post-close writes", async () => {
    const db = freshDb();
    const clock = makeClock(T0);
    let calls = 0;
    const coord = track(
      createCoordinator({
        db,
        enabledProviders: ["claude"],
        now: clock.now,
        pollFn: async () => {
          calls++;
          await sleep(100);
          return [
            {
              provider: "claude",
              status: "fulfilled",
              value: fakeQuota("claude", 10, clock.now()),
            },
          ];
        },
      }),
    );
    const p = coord.refresh();
    await sleep(20);
    coord.setClosing();
    await p;
    expect(calls).toBe(1);
    expect(getLatestByProvider(db, "claude")).toBeUndefined();
    expect(getAttempt(db, "claude")).toBeNull();
    expect(coord.getState().lastCompletedPollAt).toBeNull();
    await expect(coord.refresh()).rejects.toBeInstanceOf(ServiceClosing);
    await coord.scheduledTick();
    expect(calls).toBe(1);
  });

  it("(i) scheduled completion updates lastCompletedPollAt", async () => {
    const db = freshDb();
    const clock = makeClock(T0);
    const coord = track(
      createCoordinator({
        db,
        enabledProviders: ["claude"],
        now: clock.now,
        pollFn: async () => [
          {
            provider: "claude",
            status: "fulfilled",
            value: fakeQuota("claude", 10, clock.now()),
          },
        ],
      }),
    );
    await coord.refresh();
    expect(coord.getState().lastCompletedPollAt).toBe(iso(T0));
    clock.advance(120_000);
    await coord.scheduledTick();
    expect(coord.getState().lastCompletedPollAt).toBe(iso(T0 + 120_000));
    expect(coord.getState().lastResult?.lastPollAt).toBe(iso(T0 + 120_000));
  });

  it("reports in-progress while a poll runs", async () => {
    const db = freshDb();
    const clock = makeClock(T0);
    let seen: string | null = null;
    const coord = track(
      createCoordinator({
        db,
        enabledProviders: ["claude"],
        now: clock.now,
        pollFn: async () => {
          seen = coord.getState().polling;
          return [];
        },
      }),
    );
    expect(coord.getState().polling).toBe("idle");
    await coord.refresh();
    expect(seen).toBe("in-progress");
    expect(coord.getState().polling).toBe("cooldown");
  });

  it("self-fences: lost ownership calls onOwnershipLost and writes nothing", async () => {
    const db = freshDb();
    const clock = makeClock(T0);
    let alive = true;
    let fenced = 0;
    let calls = 0;
    const coord = track(
      createCoordinator({
        db,
        enabledProviders: ["claude"],
        now: clock.now,
        pollFn: async () => {
          calls++;
          return [
            {
              provider: "claude",
              status: "fulfilled",
              value: fakeQuota("claude", 10, clock.now()),
            },
          ];
        },
        ownershipVerify: () => alive,
        onOwnershipLost: () => {
          fenced++;
        },
      }),
    );
    await coord.refresh();
    expect(fenced).toBe(0);
    expect(getLatestByProvider(db, "claude")?.usedPct).toBe(10);

    alive = false;
    clock.advance(61_000);
    await expect(coord.refresh()).rejects.toBeInstanceOf(ServiceClosing);
    expect(fenced).toBe(1);
    // The fenced poll ran but wrote nothing new.
    expect(getAttempt(db, "claude")?.attemptedAt).toBe(iso(T0));
    const callsAfterFence = calls;
    await coord.scheduledTick();
    expect(calls).toBe(callsAfterFence);
  });

  it("logs a failed generation once and keeps the next poll scheduled", async () => {
    const db = freshDb();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const coord = track(
      createCoordinator({
        db,
        enabledProviders: ["claude"],
        pollFn: async () => {
          calls++;
          throw new Error("database write failed");
        },
      }),
    );
    coord.start(20);
    await sleep(200);
    coord.stop();
    // The schedule survived the failures.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(coord.getState().lastCompletedPollAt).toBeNull();
    // Each failure is reported exactly once, naming the cause.
    const logged = warn.mock.calls.map((c) => c.join(" "));
    expect(logged).toHaveLength(calls);
    expect(logged.every((l) => l.includes("Unrecognized diagnostic text omitted"))).toBe(true);
  });

  it("scheduled ticks fire onSettled after settling, even on failure", async () => {
    const db = freshDb();
    const settled: string[] = [];
    const coord = track(
      createCoordinator({
        db,
        enabledProviders: ["claude"],
        pollFn: async () => [
          { provider: "claude", status: "fulfilled", value: fakeQuota("claude", 10, Date.now()) },
        ],
        onSettled: () => {
          settled.push("ok");
        },
      }),
    );
    await coord.scheduledTick();
    expect(settled).toEqual(["ok"]);

    const failing = track(
      createCoordinator({
        db,
        enabledProviders: ["claude"],
        pollFn: async () => {
          throw new Error("poll exploded");
        },
        onSettled: () => {
          settled.push("failed-tick");
        },
      }),
    );
    await failing.scheduledTick();
    expect(settled).toEqual(["ok", "failed-tick"]);
  });

  it("sanitizes rejected detail across attempt, rejection aliases, results row, and lastResult without leaking secret", async () => {
    const db = freshDb();
    const fixedTime = Date.parse("2026-09-10T00:00:00Z");
    const coord = track(
      createCoordinator({
        db,
        enabledProviders: ["codex"],
        now: () => fixedTime,
        pollFn: async () => [
          {
            provider: "codex",
            status: "rejected",
            reason: new Error("Error: unauthorized token=private-value"),
          },
        ],
      }),
    );
    const result = await coord.refresh();
    const attempt = getAttempt(db, "codex")!;
    expect(attempt.failureCategory).toBe("auth");
    expect(attempt.diagnosticCode).toBe("auth");
    expect(attempt.errorDetail).toBe("unauthorized");
    expect(attempt.error).toBe(attempt.errorDetail);

    expect(result.rejected[0].diagnosticCode).toBe("auth");
    expect(result.rejected[0].category).toBe("auth");
    expect(result.rejected[0].errorDetail).toBe(attempt.errorDetail);
    expect(result.rejected[0].error).toBe(attempt.errorDetail);
    expect(result.rejected[0].reason).toBe(attempt.errorDetail);
    expect(result.results[0].reason).toBe(attempt.errorDetail);

    const lastResult = coord.getState().lastResult!;
    expect(lastResult.rejected[0].errorDetail).toBe(attempt.errorDetail);
    expect(lastResult.rejected[0].error).toBe(attempt.errorDetail);
    expect(lastResult.rejected[0].reason).toBe(attempt.errorDetail);
    expect(lastResult.results[0].reason).toBe(attempt.errorDetail);

    expect(JSON.stringify(result)).not.toContain("private-value");
    expect(JSON.stringify(lastResult)).not.toContain("private-value");
  });

  it("simultaneous refresh and cooldown calls: exactly one log and one attempt write per actual outcome", async () => {
    const db = freshDb();
    const clock = makeClock(T0);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let pollCalls = 0;
    const coord = track(
      createCoordinator({
        db,
        enabledProviders: ["claude", "codex"],
        now: clock.now,
        pollFn: async () => {
          pollCalls++;
          await sleep(50);
          return [
            {
              provider: "claude",
              status: "fulfilled",
              value: fakeQuota("claude", 20, clock.now()),
            },
            {
              provider: "codex",
              status: "rejected",
              reason: new Error("Error: unauthorized token=secret-tok"),
            },
          ];
        },
      }),
    );

    const [r1, r2] = await Promise.all([coord.refresh(), coord.refresh()]);
    expect(pollCalls).toBe(1);

    const r3 = await coord.refresh();
    expect(r3.cooldown).toBe(true);
    expect(pollCalls).toBe(1);

    const logs = logSpy.mock.calls.map((c) => c.join(" "));
    const claudeLogs = logs.filter((l) => l.includes("[claude]"));
    const codexLogs = logs.filter((l) => l.includes("[codex]"));
    expect(claudeLogs).toHaveLength(1);
    expect(claudeLogs[0]).toBe(`[${iso(T0)}] [quotacap] [claude] poll succeeded (20% used)`);
    expect(codexLogs).toHaveLength(1);
    expect(codexLogs[0]).toMatch(
      new RegExp(`^\\[${iso(T0).replace(/\+/g, "\\+")}\\] \\[quotacap\\] \\[codex\\] poll failed \\(auth\\):`),
    );
    expect(codexLogs[0]).not.toContain("secret-tok");

    const attempts = getAttempts(db);
    expect(attempts).toHaveLength(2);
    expect(attempts.find((a) => a.provider === "claude")?.success).toBe(true);
    expect(attempts.find((a) => a.provider === "codex")?.success).toBe(false);
  });

  it("logs success with percent when finite, and omits parenthetical when usedPct is not finite or array", async () => {
    const db = freshDb();
    const clock = makeClock(T0);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const coord = track(
      createCoordinator({
        db,
        enabledProviders: ["p-finite", "p-nan", "p-array"],
        now: clock.now,
        pollFn: async () => [
          {
            provider: "p-finite",
            status: "fulfilled",
            value: { provider: "p-finite", plan: "p", usedPct: 42, resetsAt: iso(T0 + 1000), periodStart: iso(T0), source: "cli", fetchedAt: iso(T0) },
          },
          {
            provider: "p-null",
            status: "fulfilled",
            value: { provider: "p-null", plan: "p", usedPct: null, resetsAt: iso(T0 + 1000), periodStart: iso(T0), source: "cli", fetchedAt: iso(T0) },
          },
          {
            provider: "p-array",
            status: "fulfilled",
            value: [{ provider: "p-array", plan: "p", usedPct: 10, resetsAt: iso(T0 + 1000), periodStart: iso(T0), source: "cli", fetchedAt: iso(T0) }],
          },
        ],
      }),
    );

    await coord.refresh();
    const logs = logSpy.mock.calls.map((c) => c.join(" "));
    const finiteLog = logs.find((l) => l.includes("[p-finite]"))!;
    const nullLog = logs.find((l) => l.includes("[p-null]"))!;
    const arrayLog = logs.find((l) => l.includes("[p-array]"))!;

    expect(finiteLog).toBe(`[${iso(T0)}] [quotacap] [p-finite] poll succeeded (42% used)`);
    expect(nullLog).toBe(`[${iso(T0)}] [quotacap] [p-null] poll succeeded`);
    expect(arrayLog).toBe(`[${iso(T0)}] [quotacap] [p-array] poll succeeded`);
  });
});
