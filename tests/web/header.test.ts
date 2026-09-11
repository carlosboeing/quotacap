import React from "react";
import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { Header, pillFor } from "../../web/src/components/Header.js";
import { repairFor } from "../../web/src/components/FaultBanner.js";

const LIVE_RUNTIME = {
  available: true,
  ready: true,
  polling: "idle",
  lastCompletedPollAt: null,
  version: "0.0.21",
} as const;

function headerHtml(props: { runtime: unknown; unreachable?: boolean }): string {
  return renderToString(
    React.createElement(Header, {
      runtime: props.runtime as any,
      unreachable: props.unreachable,
      refreshing: false,
      onRefresh: () => {},
      onSettings: () => {},
    })
  );
}

describe("header pill", () => {
  it("maps runtime states without inventing health", () => {
    expect(pillFor({ available: false, ready: false, polling: "idle" })).toBe("unreachable");
    expect(pillFor({ available: true, ready: true, polling: "in-progress" })).toBe("polling");
    expect(pillFor({ available: true, ready: true, polling: "idle" })).toBe("live");
    expect(pillFor({ available: true, ready: false, polling: "idle" })).toBe("not-ready");
  });
  it("treats cooldown as polling and a missing version as not ready", () => {
    expect(pillFor({ available: true, ready: true, polling: "cooldown" })).toBe("polling");
    expect(pillFor({ available: true, ready: true, polling: "idle", version: "" })).toBe("not-ready");
  });
  it("reports unreachable over a stale snapshot, and before the first one", () => {
    expect(headerHtml({ runtime: LIVE_RUNTIME })).toContain('data-state="live"');
    // A network failure after a good load: the stored runtime is last answer's.
    expect(headerHtml({ runtime: LIVE_RUNTIME, unreachable: true })).toContain(
      'data-state="unreachable"'
    );
    // A network failure before any load: never stuck on Connecting.
    const initial = headerHtml({ runtime: null, unreachable: true });
    expect(initial).toContain('data-state="unreachable"');
    expect(initial).not.toContain("Connecting");
    expect(headerHtml({ runtime: null })).toContain('data-state="connecting"');
  });

  it("shows the update badge only when an update is known-available", () => {
    const stale = headerHtml({
      runtime: {
        ...LIVE_RUNTIME,
        update: { current: "0.0.22", latest: "0.0.23", upToDate: false, checkedAt: "2026-09-11T00:00:00.000Z" },
      },
    });
    expect(stale).toContain('data-testid="update-badge"');
    expect(stale).toContain("Update 0.0.22 to 0.0.23");
    expect(stale).toContain("Run &#x27;quotacap update&#x27; to upgrade");

    const fresh = headerHtml({
      runtime: {
        ...LIVE_RUNTIME,
        update: { current: "0.0.23", latest: "0.0.23", upToDate: true, checkedAt: "2026-09-11T00:00:00.000Z" },
      },
    });
    expect(fresh).not.toContain("update-badge");

    const unknown = headerHtml({
      runtime: {
        ...LIVE_RUNTIME,
        update: { current: "0.0.23", latest: null, upToDate: true, checkedAt: null },
      },
    });
    expect(unknown).not.toContain("update-badge");
    expect(headerHtml({ runtime: LIVE_RUNTIME })).not.toContain("update-badge");
  });
});

describe("fault repair", () => {
  it("routes auth failures to provider sign-in and stale rows to re-poll", () => {
    const auth = repairFor({
      id: "claude",
      exclusionReason: "provider-failed",
      lastAttempt: { failureCategory: "auth" },
    } as any);
    expect(auth.text).toMatch(/sign in to the claude cli/i);
    expect(auth.text).toMatch(/never handles those credentials/i);
    const stale = repairFor({ id: "kimi", exclusionReason: "stale", lastAttempt: null } as any);
    expect(stale.text).toMatch(/poll again/i);
  });
});
