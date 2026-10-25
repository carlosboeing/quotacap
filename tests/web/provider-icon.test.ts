import { describe, it, expect } from "vitest";
import fs from "node:fs";
import React from "react";
import { renderToString } from "react-dom/server";
import { ProviderIcon, providerTint } from "../../web/src/components/ProviderIcon.js";

describe("provider mark", () => {
  it("is the display name's first letter, never a stand-in glyph", () => {
    const html = renderToString(React.createElement(ProviderIcon, { title: "grok", size: 17 }));
    expect(html).toContain(">G</span>");
    expect(html).not.toContain("<svg");
    expect(html).toContain("font-size:15px");
  });

  it("every adapter has a colour token in both themes, so no tile or table dot renders blank", () => {
    const css = fs.readFileSync("web/src/theme.css", "utf8");
    for (const id of ["claude", "codex", "kimi", "grok", "agy", "muse", "opencode-go"]) {
      expect(css.match(new RegExp(`--p-${id}: oklch`, "g"))?.length).toBe(2);
      expect(providerTint(id).color).toBe(`var(--p-${id}, var(--ink))`);
    }
  });
});
