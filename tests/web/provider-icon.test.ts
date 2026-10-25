import { describe, it, expect } from "vitest";
import fs from "node:fs";
import React from "react";
import { renderToString } from "react-dom/server";
import { ProviderIcon, providerTint, iconKey } from "../../web/src/components/ProviderIcon.js";

describe("provider mark", () => {
  it("renders official vector logo SVGs for all supported providers", () => {
    const providers = [
      { id: "claude", title: "Claude" },
      { id: "codex", title: "Codex" },
      { id: "kimi", title: "Kimi" },
      { id: "grok", title: "Grok" },
      { id: "agy", title: "Antigravity" },
      { id: "agy:3p", title: "Antigravity 3P" },
      { id: "opencode-go", title: "OpenCode Go" },
      { id: "muse", title: "Muse" },
    ];
    for (const p of providers) {
      const html = renderToString(React.createElement(ProviderIcon, { id: p.id, title: p.title, size: 18 }));
      expect(html).toContain("<svg");
      expect(html).toContain('viewBox="0 0 24 24"');
      expect(html).toContain('fill="currentColor"');
    }
  });

  it("resolves providers by title when id is omitted", () => {
    const html = renderToString(React.createElement(ProviderIcon, { title: "Anthropic Claude" }));
    expect(html).toContain("<svg");
  });

  it("falls back to a single-letter monogram for unknown providers", () => {
    const html = renderToString(React.createElement(ProviderIcon, { id: "unknown-ai", title: "Unknown AI", size: 17 }));
    expect(html).toContain(">U</span>");
    expect(html).not.toContain("<svg");
  });

  it("every adapter has a colour token in both themes, so no tile or table dot renders blank", () => {
    const css = fs.readFileSync("web/src/theme.css", "utf8");
    for (const id of ["claude", "codex", "kimi", "grok", "agy", "agy-3p", "muse", "opencode-go"]) {
      expect(css.match(new RegExp(`--p-${id}: oklch`, "g"))?.length).toBe(2);
      if (id !== "agy-3p") {
        expect(providerTint(id).color).toBe(`var(--p-${id}, var(--ink))`);
      }
    }
    expect(providerTint("agy:3p").color).toBe("var(--p-agy-3p, var(--p-agy, var(--ink)))");
  });

  it("renders authentic Lobe Icons brand paths for Grok, Codex, Antigravity, and Muse", () => {
    const grokHtml = renderToString(React.createElement(ProviderIcon, { id: "grok", title: "Grok" }));
    expect(grokHtml).toContain("M9.27 15.29l7.978-5.897");
    // Ensure old xAI corporate mark is not present
    expect(grokHtml).not.toContain("m3.005 8.858 8.783");

    const codexHtml = renderToString(React.createElement(ProviderIcon, { id: "codex", title: "Codex" }));
    expect(codexHtml).toContain("M9.205 8.658");

    const agyHtml = renderToString(React.createElement(ProviderIcon, { id: "agy", title: "Antigravity" }));
    expect(agyHtml).toContain("M21.751 22.607");

    const museHtml = renderToString(React.createElement(ProviderIcon, { id: "muse", title: "Muse" }));
    expect(museHtml).toContain("M6.897 4");
  });
});
