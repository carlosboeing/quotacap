import fs from "node:fs";
import { describe, it, expect } from "vitest";
import { exampleStateSnapshotJson } from "../fixtures/stable-state.js";
import React from "react";
import { renderToString } from "react-dom/server";
import { pillHalfWidth, placePins, ResetRail, stampHalfWidth, storedRailMode } from "../../web/src/components/ResetRail.js";
import { resetClock } from "../../web/src/components/PaceBar.js";

/** Pill-or-timestamp box of a placed pin at the default reference width. */
function boxOf(pin: any, width = 1072): [number, number] {
  const stamp = `${resetClock(pin.resetsAt) ?? ""}${pin.estimated ? " (est.)" : ""}`;
  const half = Math.max(pillHalfWidth(pin.label), stampHalfWidth(stamp));
  const center = (pin.positionPct / 100) * width + pin.offsetPx;
  return [center - half, center + half];
}

describe("reset rail", () => {
  it("places crowded pins individually by default, clustering only in grouped mode", () => {
    const rows = [
      { id: "a", label: "AA", resetsAt: "2026-09-08T06:00:00+10:00" },
      { id: "b", label: "BB", resetsAt: "2026-09-08T06:20:00+10:00" },
      { id: "c", label: "CC", resetsAt: "2026-09-08T06:40:00+10:00" },
      { id: "d", label: "DD", resetsAt: "2026-09-08T07:00:00+10:00" },
      { id: "far", label: "Far", resetsAt: "2026-10-01T06:00:00+10:00" },
    ];
    const asOf = new Date("2026-09-07T06:00:00+10:00");
    const pins = placePins(rows, asOf);
    expect(pins.clusters).toHaveLength(0);
    expect(pins.placed.map((p: any) => p.id)).toEqual(["a", "b", "c", "d"]);
    expect(pins.overflow.map((o: any) => o.id)).toContain("far");
    expect(pins.invalid).toHaveLength(0);
    // same-band pairs split sideways with exactly the dodge gap between boxes
    const [a, c] = [pins.placed[0], pins.placed[2]];
    expect(a.band).toBe("above");
    expect(c.band).toBe("above");
    expect(a.offsetPx).toBeLessThan(0);
    expect(c.offsetPx).toBeGreaterThan(0);
    expect(boxOf(c)[0] - boxOf(a)[1]).toBeCloseTo(6, 4);
    const grouped = placePins(rows, asOf, { grouped: true });
    expect(grouped.clusters).toHaveLength(1);
    expect(grouped.clusters[0].ids).toHaveLength(4);
    expect(grouped.overflow.map((o: any) => o.id)).toContain("far");
  });
  it("keeps same-band pins centered when their pills fit side by side", () => {
    // Codex and OpenCode Go 17.5h apart: pills need ~95px, the rail gives ~112
    const pins = placePins(
      [
        { id: "codex", label: "Codex", resetsAt: "2026-09-08T06:00:00+10:00" },
        { id: "filler", label: "Filler", resetsAt: "2026-09-08T07:00:00+10:00" },
        { id: "opencode", label: "OpenCode Go", resetsAt: "2026-09-08T23:30:00+10:00" },
      ],
      new Date("2026-09-07T06:00:00+10:00")
    );
    expect(pins.placed.map((p: any) => p.band)).toEqual(["above", "below", "above"]);
    expect(pins.placed[0].offsetPx).toBe(0);
    expect(pins.placed[2].offsetPx).toBe(0);
  });
  it("tolerates small grazes instead of dodging", () => {
    // pills 2px into each other stay centered; only real overlap dodges
    const pins = placePins(
      [
        { id: "codex", label: "Codex", resetsAt: "2026-09-08T06:00:00+10:00" },
        { id: "filler", label: "Filler", resetsAt: "2026-09-08T07:00:00+10:00" },
        { id: "opencode", label: "OpenCode Go Plus!", resetsAt: "2026-09-08T22:30:00+10:00" },
      ],
      new Date("2026-09-07T06:00:00+10:00")
    );
    expect(pins.placed.map((p: any) => p.band)).toEqual(["above", "below", "above"]);
    expect(pins.placed[0].offsetPx).toBe(0);
    expect(pins.placed[2].offsetPx).toBe(0);
    const graze = boxOf(pins.placed[2])[0] - boxOf(pins.placed[0])[1];
    expect(graze).toBeGreaterThan(-10);
    expect(graze).toBeLessThan(6);
  });
  it("clamps only overflowing singletons into the rail edges", () => {
    const pins = placePins(
      [
        { id: "wide", label: "Antigravity 3P", resetsAt: "2026-09-13T23:00:00+10:00" },
        { id: "narrow", label: "Kimi", resetsAt: "2026-09-13T21:36:00+10:00" },
      ],
      new Date("2026-09-07T06:00:00+10:00")
    );
    // narrow pill already fits: untouched, vertical stem
    expect(pins.placed[0].id).toBe("narrow");
    expect(pins.placed[0].offsetPx).toBe(0);
    // wide pill would hang off the rail: shift exactly back inside
    expect(pins.placed[1].offsetPx).toBeLessThan(0);
    expect(boxOf(pins.placed[1])[1]).toBeCloseTo(1072, 4);
  });
  it("clusters trios in grouped mode so the toggle bites on real data", () => {
    const rows = [
      { id: "a", label: "AA", resetsAt: "2026-09-08T06:00:00+10:00" },
      { id: "b", label: "BB", resetsAt: "2026-09-08T06:20:00+10:00" },
      { id: "c", label: "CC", resetsAt: "2026-09-08T06:40:00+10:00" },
    ];
    const asOf = new Date("2026-09-07T06:00:00+10:00");
    const pins = placePins(rows, asOf);
    expect(pins.clusters).toHaveLength(0);
    expect(pins.placed.map((p: any) => p.id)).toEqual(["a", "b", "c"]);
    expect(pins.placed.map((p: any) => p.band)).toEqual(["above", "below", "above"]);
    // the above pair dodges; the lone below pin stays centered
    expect(pins.placed[0].offsetPx).toBeLessThan(0);
    expect(pins.placed[1].offsetPx).toBe(0);
    expect(pins.placed[2].offsetPx).toBeGreaterThan(0);
    const grouped = placePins(rows, asOf, { grouped: true });
    expect(grouped.clusters).toHaveLength(1);
    expect(grouped.clusters[0].ids).toHaveLength(3);
  });
  it("shingles crowds past the spread cap with bounded drift", () => {
    const rows = [0, 1, 2, 3, 4, 5].map((i) => ({
      id: `p${i}`,
      label: `P${i}`,
      resetsAt: `2026-09-08T06:0${i}:00+10:00`,
    }));
    const pins = placePins(rows, new Date("2026-09-07T06:00:00+10:00"));
    expect(pins.clusters).toHaveLength(0);
    expect(pins.placed).toHaveLength(6);
    // same-band triples compress into shingles: small overlap, drift capped
    for (const pin of pins.placed as any[]) {
      expect(Math.abs(pin.offsetPx)).toBeLessThan(80);
    }
    const above = (pins.placed as any[]).filter((p) => p.band === "above");
    expect(above).toHaveLength(3);
    const steps = [boxOf(above[1])[0] - boxOf(above[0])[0], boxOf(above[2])[0] - boxOf(above[1])[0]];
    for (const step of steps) {
      expect(step).toBeGreaterThan(30); // exposed hover strip survives
      expect(step).toBeLessThan(71.4 + 6); // ...but pills overlap instead of clearing
    }
  });
  it("clamps dodge groups inside the rail edges", () => {
    const asOf = new Date("2026-09-07T06:00:00+10:00");
    const right = placePins(
      [
        { id: "a", label: "Antigravity 3P", resetsAt: "2026-09-13T18:00:00+10:00" },
        { id: "b", label: "Filler", resetsAt: "2026-09-13T18:10:00+10:00" },
        { id: "c", label: "OpenCode Go", resetsAt: "2026-09-13T18:20:00+10:00" },
      ],
      asOf
    );
    for (const pin of right.placed as any[]) {
      const [left, rightEdge] = boxOf(pin);
      expect(left).toBeGreaterThanOrEqual(-0.001);
      expect(rightEdge).toBeLessThanOrEqual(1072.001);
    }
    const left = placePins(
      [
        { id: "a", label: "Antigravity 3P", resetsAt: "2026-09-07T12:00:00+10:00" },
        { id: "b", label: "Filler", resetsAt: "2026-09-07T12:10:00+10:00" },
        { id: "c", label: "OpenCode Go", resetsAt: "2026-09-07T12:20:00+10:00" },
      ],
      asOf
    );
    for (const pin of left.placed as any[]) {
      const [l, r] = boxOf(pin);
      expect(l).toBeGreaterThanOrEqual(-0.001);
      expect(r).toBeLessThanOrEqual(1072.001);
    }
  });
  it("drops invalid and reset-passed rows from the future rail", () => {
    const pins = placePins(
      [
        { id: "bad", label: "Bad", resetsAt: "not-a-date" },
        { id: "past", label: "Past", resetsAt: "2026-09-01T06:00:00+10:00" },
      ],
      new Date("2026-09-07T06:00:00+10:00")
    );
    expect(pins.placed).toHaveLength(0);
  });
  it("dodges the fixture's same-day resets, clustering only in grouped mode", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const rows = s.providers
      .filter((p: any) => p.enabled && p.quota)
      .map((p: any) => ({
        id: p.id,
        label: p.displayName ?? p.id,
        resetsAt: p.quota.resetsAt,
        estimated: !!p.quota.resetsAtEstimated,
      }));
    const pins = placePins(rows, new Date(s.asOf));
    expect(pins.clusters).toHaveLength(0);
    expect(pins.placed).toHaveLength(6);
    expect(pins.overflow).toHaveLength(0);
    expect(pins.invalid.map((r: any) => r.id)).toEqual(["grok"]);
    const grouped = placePins(rows, new Date(s.asOf), { grouped: true });
    expect(grouped.clusters).toHaveLength(1);
    expect(grouped.clusters[0].ids).toHaveLength(6);
  });
  it("defaults the rail mode to separate without stored choice", () => {
    expect(storedRailMode()).toBe("separate");
  });
  it("paints pin labels with pace color classes from server badges", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const asOf = new Date(Date.parse(s.asOf) - 24 * 60 * 60 * 1000).toISOString();
    const html = renderToString(
      React.createElement(ResetRail, {
        providers: s.providers.map((p: any, i: number) =>
          p.quota
            ? {
                ...p,
                quota: {
                  ...p.quota,
                  resetsAt: new Date(Date.parse(asOf) + (i + 1) * 24 * 60 * 60 * 1000).toISOString(),
                },
              }
            : p
        ),
        asOf,
        onSelectProvider: () => {},
      })
    );
    expect(html).toMatch(/pin-label pace-(behind|ontrack|ahead|cap|out)/);
    expect(html).toMatch(/pin-tooltip/);
    expect(html).not.toMatch(/data-testid="pin"[^>]*\stitle=/);
  });
  it("paints Watch pins with the amber watch token, not the neutral out style", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const claude = s.providers.find((p: any) => p.id === "claude");
    const asOf = new Date(Date.parse(s.asOf) - 24 * 60 * 60 * 1000).toISOString();
    const providers = [
      {
        ...claude,
        advisory: { ...claude.advisory, status: "watch" },
        quota: {
          ...claude.quota,
          resetsAt: new Date(Date.parse(asOf) + 2 * 24 * 60 * 60 * 1000).toISOString(),
        },
      },
    ];
    const html = renderToString(
      React.createElement(ResetRail, { providers, asOf, onSelectProvider: () => {} })
    );
    expect(html).toMatch(/pin-label pace-watch/);
    expect(html).toContain("--dot-color:var(--watch)");
    expect(html).not.toMatch(/pin-label pace-out/);
  });
  // The pill used to render name.split(" ")[0], so "Antigravity" and
  // "Antigravity 3P" both showed as "Antigravity", and the estimate marker
  // was appended to the name rather than the timestamp it qualifies.
  it("shows the whole display name and keeps (est.) out of the name pill", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const asOf = new Date(Date.parse(s.asOf) - 24 * 60 * 60 * 1000).toISOString();
    const providers = s.providers.map((p: any, i: number) =>
      p.quota
        ? {
            ...p,
            displayName: `Antigravity ${i}P`,
            quota: {
              ...p.quota,
              resetsAt: new Date(Date.parse(asOf) + (i + 1) * 24 * 60 * 60 * 1000).toISOString(),
              resetsAtEstimated: i === 0,
            },
          }
        : p
    );
    const html = renderToString(
      React.createElement(ResetRail, { providers, asOf, onSelectProvider: () => {} })
    );
    // the full multi-word name reaches the pill, not just its first word
    expect(html).toMatch(/pin-label[^>]*>Antigravity 0P</);
    // the estimate marker qualifies the timestamp, so it must not be in the pill
    expect(html).not.toMatch(/pin-label[^>]*>[^<]*\(est\.\)/);
    expect(html).toMatch(/pin-when[^>]*>[^<]*\(est\.\)/);
  });

  it("renders dodged pills with diagonal stems on a flat rail", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const html = renderToString(
      React.createElement(ResetRail, {
        providers: s.providers,
        asOf: s.asOf,
        onSelectProvider: () => {},
      })
    );
    // the fixture's same-day crowd dodges sideways with rotated stems
    expect(html).toMatch(/translate:-?\d+(\.\d+)?px 0/);
    expect(html).toMatch(/rotate\(-?\d+(\.\d+)?deg\)/);
    expect(html).toContain('data-testid="rail-mode"');
    expect(html).not.toContain("cluster-pin");
    // the rail keeps its fixed height: no inline geometry anywhere
    expect(html).toContain('<div class="rail">');
    expect(html).not.toMatch(/class="rail-axis" style/);
  });

  it("keeps edge-pin tooltips inside the rail instead of centered", () => {
    const css = fs.readFileSync("web/src/theme.css", "utf8");
    expect(css).toMatch(/\.pin\.pin-end \.pin-tooltip/);
    expect(css).toMatch(/\.pin\.pin-start \.pin-tooltip/);
    expect(css).toMatch(/\.pin\.pin-end:hover \.pin-tooltip/);
  });

  it("rotates dodged stems about the dot end", () => {
    const css = fs.readFileSync("web/src/theme.css", "utf8");
    expect(css).toMatch(/\.pin\.above \.pin-stem \{[^}]*transform-origin: bottom center/);
    expect(css).toMatch(/\.pin\.below \.pin-stem \{[^}]*transform-origin: top center/);
    expect(css).toMatch(/\.pin-stem \{[^}]*height: 14px/);
    expect(css).not.toMatch(/\.pin \.leader/);
    // shingled crowds resolve by hover: the hovered pin paints above all
    expect(css).toMatch(/\.pin:hover,\s*\.pin:focus-visible \{[^}]*z-index: 70 !important/);
  });

  // Regression: pin-start and pin-end used to shift the whole pin button so
  // its pill stayed on the rail, which dragged the dot (the data point) off
  // its time coordinate by half a pill width. Dots stay anchored now; layout
  // clamps edge pills with an exact px offset and a diagonal stem, and the
  // classes survive only for tooltip placement.
  it("anchors edge-pin dots and lets layout clamp the text", () => {
    const css = fs.readFileSync("web/src/theme.css", "utf8");
    expect(css).toMatch(/\.pin \{[^}]*transform: translateX\(-50%\)/);
    expect(css).not.toMatch(/\.pin\.pin-start\s*\{[^}]*transform:/);
    expect(css).not.toMatch(/\.pin\.pin-end\s*\{[^}]*transform:/);
    expect(css).not.toMatch(/\.pin\.pin-(?:start|end) \.pin-(?:dot|stem|label|when)/);
    expect(css).toMatch(/\.pin\.pin-start \.pin-tooltip/);
    expect(css).toMatch(/\.pin\.pin-end \.pin-tooltip/);
  });
});
