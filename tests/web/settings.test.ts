import fs from "node:fs";
import React from "react";
import { renderToString } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
import { exampleStateSnapshotJson } from "../fixtures/stable-state.js";
import {
  adapterProviders,
  connectionBadge,
  connectionName,
  providerStatus,
  ProvidersPanel,
  statusPillClass,
} from "../../web/src/components/settings/ProvidersPanel.js";
import { CliIntegrationPanel } from "../../web/src/components/settings/CliIntegrationPanel.js";
import { DaemonPanel } from "../../web/src/components/settings/DaemonPanel.js";

/** The unit harness has no DOM: find the row button in the element tree and invoke it. */
function findRowButton(node: any, label: string): any {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findRowButton(child, label);
      if (hit) return hit;
    }
    return null;
  }
  if (node.type === "button" && node.props?.["aria-label"] === label) return node;
  return findRowButton(node.props?.children, label);
}

describe("settings", () => {
  it("lists CLI adapters only, omitting manual ingest ids", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const ids = adapterProviders(s.providers).map((p: { id: string }) => p.id);
    expect(ids).toContain("kimi");
    expect(ids).toContain("agy:3p");
    expect(ids).not.toContain("manual");
    expect(ids).not.toContain("my-plan");
    expect(ids).not.toContain("test");
  });
  it("labels provider status from server attempt and exclusion fields", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const byId = new Map<string, any>(s.providers.map((p: any) => [p.id, p]));
    expect(providerStatus(byId.get("kimi"))).toBe("Ready");
    expect(providerStatus(byId.get("agy:3p"))).toBe("Stale");
    expect(providerStatus(byId.get("grok"))).toBe("Invalid");
    expect(providerStatus(byId.get("manual"))).toBe("Not reporting");
  });
  it("uses mock connection names and puts last-read on the status pill", () => {
    expect(connectionName("kimi")).toBe("Kimi Code");
    expect(connectionName("claude")).toBe("Claude Code");
    expect(connectionName("agy")).toBe("Antigravity");
    expect(connectionName("opencode-go")).toBe("OpenCode Go");
    expect(connectionName("muse")).toBe("Muse Code");
    const s = JSON.parse(exampleStateSnapshotJson);
    const kimi = s.providers.find((p: { id: string }) => p.id === "kimi");
    expect(connectionBadge(kimi)).toMatch(/^Ready · /);
    const stale = s.providers.find((p: { id: string }) => p.id === "agy:3p");
    expect(connectionBadge(stale)).toMatch(/^Stale · /);
  });
  it("renders a per-row enable/disable control that calls the handler", () => {
    const onSetProviderEnabled = vi.fn();
    const providers = [
      { id: "opencode-go", displayName: "OpenCode Go", harness: "OpenCode", vendor: "Anomaly", enabled: false, quota: null, exclusionReason: null, lastAttempt: null },
    ];
    const props = {
      providers: providers as any,
      refreshing: false,
      onSetProviderEnabled,
    };
    const html = renderToString(React.createElement(ProvidersPanel, props));
    expect(html).toMatch(/aria-label="Enable OpenCode Go"/);
    const btn = findRowButton((ProvidersPanel as any)(props), "Enable OpenCode Go");
    expect(btn).toBeTruthy();
    btn.props.onClick();
    expect(onSetProviderEnabled).toHaveBeenCalledWith("opencode-go", true);
  });
  it("hides the enable/disable toggle for agy:3p while keeping it for normal rows", () => {
    const onSetProviderEnabled = vi.fn();
    const providers = [
      { id: "agy:3p", displayName: "Antigravity 3P", harness: "Antigravity", vendor: "Google", enabled: true, quota: null, exclusionReason: null, lastAttempt: null },
      { id: "claude", displayName: "Claude Code", harness: "Claude Code", vendor: "Anthropic", enabled: true, quota: null, exclusionReason: null, lastAttempt: null },
    ];
    const props = {
      providers: providers as any,
      refreshing: false,
      onSetProviderEnabled,
    };
    const html = renderToString(React.createElement(ProvidersPanel, props));
    expect(html).not.toMatch(/aria-label="Disable Antigravity 3P"/);
    expect(html).toMatch(/aria-label="Disable Claude Code"/);
    const tree = (ProvidersPanel as any)(props);
    expect(findRowButton(tree, "Disable Antigravity 3P")).toBeNull();
    expect(findRowButton(tree, "Disable Claude Code")).toBeTruthy();
  });

  it("paints Failed/Invalid pills red and keeps Stale/Reset passed amber, with no Re-poll button", () => {
    expect(statusPillClass("Failed")).toContain("pill-danger");
    expect(statusPillClass("Invalid")).toContain("pill-danger");
    expect(statusPillClass("Stale")).toContain("pill-warn");
    expect(statusPillClass("Reset passed")).toContain("pill-warn");
    expect(statusPillClass("Ready")).toContain("pill-ready");
    const base = {
      displayName: "X",
      harness: "H",
      vendor: "V",
      enabled: true,
      quota: { source: "cli", weeklyPct: 10, resetsAt: "2026-09-14T06:00:00+10:00" },
      lastAttempt: null,
      ageMs: 60_000,
    };
    const providers = [
      { ...base, id: "kimi", exclusionReason: "provider-failed" },
      { ...base, id: "grok", exclusionReason: "invalid" },
      { ...base, id: "claude", exclusionReason: "stale" },
      { ...base, id: "codex", exclusionReason: "reset-passed" },
    ] as any;
    const html = renderToString(
      React.createElement(ProvidersPanel, { providers, refreshing: false, onSetProviderEnabled: () => {} })
    );
    expect(html).toMatch(/pill pill-danger[^>]*>Failed/);
    expect(html).toMatch(/pill pill-danger[^>]*>Invalid/);
    expect(html).toMatch(/pill pill-warn[^>]*>Stale/);
    expect(html).toMatch(/pill pill-warn[^>]*>Reset passed/);
    expect(html).not.toContain("Re-poll adapters");
    const css = fs.readFileSync("web/src/theme.css", "utf8");
    expect(css).toMatch(/\.pill-danger \{[^}]*var\(--danger\)/);
    expect(css).toMatch(/\.pill-warn \{[^}]*var\(--warn\)/);
    // onRefresh is gone from the panel, drawer, and App call sites.
    expect(fs.readFileSync("web/src/components/settings/ProvidersPanel.tsx", "utf8")).not.toContain("onRefresh");
    expect(fs.readFileSync("web/src/components/settings/ProvidersPanel.tsx", "utf8")).not.toContain("Re-poll");
    expect(fs.readFileSync("web/src/components/settings/SettingsDrawer.tsx", "utf8")).not.toContain("onRefresh");
    expect(fs.readFileSync("web/src/App.tsx", "utf8")).not.toMatch(/<SettingsDrawer[^>]*onRefresh/);
  });

  it("CLI panel has copy buttons on snippets at t-2 and no CLI Status Commands block", () => {
    const html = renderToString(React.createElement(CliIntegrationPanel));
    expect(html).toContain("cli-wrap");
    expect(html).toContain(">Copy<");
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("CLI Status Commands");
    expect(html).not.toContain("quotacap status --sort");
    expect(html).not.toContain("quotacap status --ascii");
    const css = fs.readFileSync("web/src/theme.css", "utf8");
    expect(css).toMatch(/\.cli-snippet \{[^}]*font-size: var\(--t-2\)/);
  });

  it("Daemon panel shows port/cadence as read-only rows with no disabled inputs or Storage Engine row", () => {
    const html = renderToString(React.createElement(DaemonPanel)).replace(/<!-- -->/g, "");
    expect(html).toContain("HTTP Service");
    expect(html).toContain("Polling Cadence");
    expect(html).toContain("Every 10 minutes (default)");
    expect(html).toContain("Database File");
    expect(html).toContain("127.0.0.1:8787");
    expect(html).not.toContain("Storage Engine");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("disabled");
  });
});
