import fs from "node:fs";
import { describe, it, expect } from "vitest";
import { exampleStateSnapshotJson } from "../fixtures/stable-state.js";
import React from "react";
import { renderToString } from "react-dom/server";
import { placePins, ResetRail } from "../../web/src/components/ResetRail.js";

describe("reset rail", () => {
  it("groups crowded pins and overflows distant resets", () => {
    const pins = placePins(
      [
        { id: "a", resetsAt: "2026-09-08T06:00:00+10:00" },
        { id: "b", resetsAt: "2026-09-08T06:20:00+10:00" },
        { id: "c", resetsAt: "2026-09-08T06:40:00+10:00" },
        { id: "far", resetsAt: "2026-10-01T06:00:00+10:00" },
      ],
      new Date("2026-09-07T06:00:00+10:00")
    );
    expect(pins.clusters.length).toBeGreaterThan(0);
    expect(pins.overflow.map((o: any) => o.id)).toContain("far");
    expect(pins.invalid).toHaveLength(0);
  });
  it("drops invalid and reset-passed rows from the future rail", () => {
    const pins = placePins(
      [
        { id: "bad", resetsAt: "not-a-date" },
        { id: "past", resetsAt: "2026-09-01T06:00:00+10:00" },
      ],
      new Date("2026-09-07T06:00:00+10:00")
    );
    expect(pins.placed).toHaveLength(0);
  });
  it("clusters the fixture's same-day resets and flags the invalid row", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const rows = s.providers
      .filter((p: any) => p.enabled && p.quota)
      .map((p: any) => ({ id: p.id, resetsAt: p.quota.resetsAt, estimated: !!p.quota.resetsAtEstimated }));
    const pins = placePins(rows, new Date(s.asOf));
    expect(pins.clusters).toHaveLength(1);
    expect(pins.clusters[0].ids).toHaveLength(6);
    expect(pins.overflow).toHaveLength(0);
    expect(pins.invalid.map((r: any) => r.id)).toEqual(["grok"]);
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
  it("keeps edge-pin tooltips inside the rail instead of centered", () => {
    const css = fs.readFileSync("web/src/theme.css", "utf8");
    expect(css).toMatch(/\.pin\.pin-end \.pin-tooltip/);
    expect(css).toMatch(/\.pin\.pin-start \.pin-tooltip/);
    expect(css).toMatch(/\.pin\.pin-end:hover \.pin-tooltip/);
  });
});
