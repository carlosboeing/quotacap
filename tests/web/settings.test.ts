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
} from "../../web/src/components/settings/ProvidersPanel.js";

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
      onRefresh: () => {},
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
      onRefresh: () => {},
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
});
