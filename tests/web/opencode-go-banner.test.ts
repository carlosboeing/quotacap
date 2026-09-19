import fs from "node:fs";
import React from "react";
import { renderToString } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
import {
  ConsentModal,
  OpencodeGoBanner,
  OPENCODE_GO_CONSENT_COPY,
  showOpenCodeGoBanner,
} from "../../web/src/components/OpencodeGoBanner.js";
import { OPENCODE_GO_CONSENT_NOTICE } from "../../src/adapters/opencode-go.js";

// The unit harness has no DOM and no @testing-library: components are
// direct-called and walked as element trees (see settings.test.ts). The
// modal's Escape effect is a no-op stub so the direct call does not throw.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: () => undefined };
});

/** Concatenated text of an element subtree, mirroring textContent. */
function textOf(node: any): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && node.props) return textOf(node.props.children);
  return "";
}

/** First button whose aria-label or text matches, walking the element tree. */
function findButton(node: any, match: (label: string) => boolean): any {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButton(child, match);
      if (hit) return hit;
    }
    return null;
  }
  if (node.type === "button") {
    const label =
      typeof node.props?.["aria-label"] === "string" ? node.props["aria-label"] : textOf(node);
    if (match(label)) return node;
  }
  return findButton(node.props?.children, match);
}

function findNode(node: any, match: (n: any) => boolean): any {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, match);
      if (hit) return hit;
    }
    return null;
  }
  if (match(node)) return node;
  return findNode(node.props?.children, match);
}

describe("showOpenCodeGoBanner", () => {
  const providers = [{ id: "opencode-go", enabled: false }] as any;

  it("shows when detected, not enabled, not suppressed", () => {
    expect(showOpenCodeGoBanner({ detectedProviders: ["opencode-go"] }, providers, false)).toBe(true);
  });

  it("hides when already enabled, undetected, or suppressed", () => {
    expect(showOpenCodeGoBanner({ detectedProviders: ["opencode-go"] }, [{ id: "opencode-go", enabled: true }] as any, false)).toBe(false);
    expect(showOpenCodeGoBanner({ detectedProviders: [] }, providers, false)).toBe(false);
    expect(showOpenCodeGoBanner({ detectedProviders: ["opencode-go"] }, providers, true)).toBe(false);
  });

  it("treats a missing field as undetected (older daemon)", () => {
    expect(showOpenCodeGoBanner({}, providers, false)).toBe(false);
  });
});

describe("web consent copy parity", () => {
  it("matches the server-side consent notice verbatim", () => {
    expect(OPENCODE_GO_CONSENT_COPY).toBe(OPENCODE_GO_CONSENT_NOTICE);
  });
});

describe("OpencodeGoBanner", () => {
  it("renders the detection copy and an enable action", () => {
    const onEnable = vi.fn();
    const tree = (OpencodeGoBanner as any)({ onEnable });
    const html = renderToString(tree);
    expect(html).toContain('data-testid="opencode-go-banner"');
    expect(html).toContain('role="status"');
    expect(textOf(tree)).toMatch(/OpenCode Go detected/i);
    const btn = findButton(tree, (label) => /enable opencode go/i.test(label));
    expect(btn).toBeTruthy();
    btn.props.onClick();
    expect(onEnable).toHaveBeenCalledTimes(1);
  });
});

describe("ConsentModal", () => {
  it("renders the verbatim notice with confirm and cancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const tree = (ConsentModal as any)({ onConfirm, onCancel });
    const html = renderToString(tree);
    expect(html).toContain('role="dialog"');
    const dialog = findNode(tree, (n) => n.props?.role === "dialog");
    expect(dialog).toBeTruthy();
    expect(textOf(dialog)).toContain(OPENCODE_GO_CONSENT_COPY);
    const cancel = findButton(tree, (label) => /cancel/i.test(label));
    expect(cancel).toBeTruthy();
    cancel.props.onClick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    const enable = findButton(tree, (label) => /^enable$/i.test(label));
    expect(enable).toBeTruthy();
    enable.props.onClick();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("disables both actions while busy", () => {
    const tree = (ConsentModal as any)({ onConfirm: vi.fn(), onCancel: vi.fn(), busy: true });
    const cancel = findButton(tree, (label) => /cancel/i.test(label));
    expect(cancel.props.disabled).toBe(true);
    const enabling = findButton(tree, (label) => /enabling/i.test(label));
    expect(enabling.props.disabled).toBe(true);
  });
});

describe("setup-mode reachability", () => {
  // SSR runs no effects, so an App-level render cannot reach the setup branch
  // headlessly (loadState never fires, snapshot stays null). Structural gate on
  // the setup-mode return instead, same style as responsive.test.ts's CSS read.
  it("keeps the notice and consent modal inside the setup-mode return", () => {
    const src = fs.readFileSync("web/src/App.tsx", "utf8");
    const start = src.indexOf("if (snapshot && setupMode)");
    const setupBlock = src.slice(start, src.indexOf("\n  return (", start));
    expect(setupBlock).toContain('data-testid="refresh-notice"');
    expect(setupBlock).toContain('role="status"');
    expect(setupBlock).toContain("<ConsentModal");
    expect(setupBlock).toContain("busy={consentBusy}");
    expect(setupBlock).toContain("onSetProviderEnabled={handleSetProviderEnabled}");
  });
});
