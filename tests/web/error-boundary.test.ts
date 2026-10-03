import React from "react";
import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import {
  CardErrorFallback,
  DrawerErrorFallback,
  ErrorBoundary,
  RowErrorFallback,
} from "../../web/src/components/ErrorBoundary.js";

describe("error boundary", () => {
  it("starts healthy and captures a render error into state", () => {
    const boundary = new ErrorBoundary({ fallback: null, children: null });
    expect(boundary.state).toEqual({ error: null });
    const err = new Error("boom");
    expect(ErrorBoundary.getDerivedStateFromError(err)).toEqual({ error: err });
  });

  it("renders children when healthy", () => {
    const html = renderToString(
      React.createElement(ErrorBoundary, { fallback: "fallback" }, "healthy")
    );
    expect(html).toContain("healthy");
    expect(html).not.toContain("fallback");
  });

  // renderToString escapes apostrophes; normalize before asserting copy.
  const text = (html: string) => html.replace(/&#x27;/g, "'");

  it("names the crashed subscription in the card and row fallbacks", () => {
    const card = text(
      renderToString(React.createElement(CardErrorFallback, { id: "codex", name: "Codex" }))
    );
    expect(card).toContain('data-testid="provider-card-codex-error"');
    expect(card).toContain("Codex");
    expect(card).toContain("Couldn't show this subscription.");
    expect(card).toContain('role="alert"');
    const row = text(
      renderToString(React.createElement(RowErrorFallback, { id: "codex", name: "Codex" }))
    );
    expect(row).toContain('data-testid="provider-row-codex-error"');
    expect(row).toContain("Codex");
    expect(row).toContain("Couldn't show this subscription.");
    expect(row).toContain('role="alert"');
  });

  it("offers a way out of the drawer fallback", () => {
    const html = text(
      renderToString(
        React.createElement(DrawerErrorFallback, { name: "Codex", onClose: () => {} })
      )
    );
    expect(html).toContain('data-testid="provider-drawer-error"');
    expect(html).toContain("Codex");
    expect(html).toContain("Couldn't show these details.");
    expect(html).toContain('aria-label="Close provider details"');
    expect(html).toContain('data-testid="drawer-scrim"');
  });
});
