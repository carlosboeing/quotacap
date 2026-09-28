import { describe, it, expect } from "vitest";
import { renderScreen, cellWidth, parseScreens } from "../../src/adapters/vt.js";
import type { ParsedQuota } from "../../src/adapters/types.js";

describe("renderScreen", () => {
  it("passes plain text through (fixtures render to themselves)", () => {
    expect(renderScreen("Weekly limit (SuperGrok)  26%\nCredits: 4.85\n")).toBe(
      "Weekly limit (SuperGrok)  26%\nCredits: 4.85",
    );
  });

  it("rstrips trailing spaces and drops trailing blank rows", () => {
    expect(renderScreen("hi   \nbye\n\n")).toBe("hi\nbye");
  });

  it("ignores SGR styling", () => {
    expect(renderScreen("\x1b[31mred\x1b[0m \x1b[1mbold\x1b[22m")).toBe("red bold");
  });

  it("skips OSC sequences (BEL- and ST-terminated)", () => {
    expect(renderScreen("\x1b]0;title\x07hi")).toBe("hi");
    expect(renderScreen("\x1b]10;rgb:ffff/ffff/ffff\x1b\\hi")).toBe("hi");
  });

  it("overwrites on cursor-back (CUB)", () => {
    expect(renderScreen("AB\x1b[1DCD")).toBe("ACD");
  });

  it("positions absolutely with CUP", () => {
    expect(renderScreen("\x1b[2;5Hhi")).toBe("\n    hi");
  });

  it("moves relatively with CUU/CUD/CUF/CUB and CHA", () => {
    expect(renderScreen("abcdef\x1b[3DXY")).toBe("abcXYf");
    expect(renderScreen("abcdef\x1b[1GXY")).toBe("XYcdef");
    expect(renderScreen("ab\x1b[1B\x1b[1CXY")).toBe("ab\n   XY");
  });

  it("steps over a blank cell with CUF (the grok October5 artifact)", () => {
    // Bytes carry no space; the screen shows one. Byte-stream stripping
    // yields "October5," — the grid yields what the user sees.
    expect(renderScreen("Resets: October\x1b[1C5, 10:22")).toBe("Resets: October 5, 10:22");
  });

  it("clears lines with EL modes", () => {
    expect(renderScreen("hello\x1b[1G\x1b[K")).toBe("");
    expect(renderScreen("hello\x1b[3G\x1b[K")).toBe("he");
    expect(renderScreen("hello\x1b[3G\x1b[1K")).toBe("   lo");
    expect(renderScreen("hello\x1b[2K")).toBe("");
  });

  it("clears the screen with ED 2J", () => {
    expect(renderScreen("a\x1b[2J\x1b[Hb")).toBe("b");
  });

  it("overwrites the line on carriage return (spinner frames collapse)", () => {
    expect(renderScreen("aaa\rbbb")).toBe("bbb");
  });

  it("handles backspace and tab", () => {
    expect(renderScreen("abc\bd")).toBe("abd");
    expect(renderScreen("a\tb")).toBe("a       b");
  });

  it("entering alt-screen wipes to a fresh buffer", () => {
    expect(renderScreen("shell noise\x1b[?1049hTUI")).toBe("TUI");
  });

  it("scrolls within DECSTBM regions", () => {
    const out = renderScreen("1\n2\n3\x1b[2;3r\x1b[3;1H\n", { rows: 3, cols: 10 });
    expect(out).toBe("1\n3");
  });

  it("scrolls the screen when writing past the bottom", () => {
    const out = renderScreen("1\n2\n3\n4", { rows: 3, cols: 10 });
    expect(out).toBe("2\n3\n4");
  });

  it("counts wide characters as two cells", () => {
    // あ is U+3042 (hiragana, wide): b sits at 1-based column 4.
    expect(renderScreen("aあb\x1b[1;4HX")).toBe("aあX");
    expect(renderScreen("aあb")).toBe("aあb");
  });

  it("treats box drawing and braille as single width", () => {
    expect(renderScreen("─│⣀\x1b[1;1HX")).toBe("X│⣀");
  });

  it("tolerates a truncated escape at kill time", () => {
    expect(renderScreen("hi\x1b[")).toBe("hi");
    expect(renderScreen("hi\x1b")).toBe("hi");
  });

  it("ignores unknown sequences without losing following text", () => {
    expect(renderScreen("a\x1b[9~b")).toBe("ab");
  });

  it("saves and restores the cursor", () => {
    expect(renderScreen("ab\x1b7\x1b[1GXY\x1b8Z")).toBe("XYZ");
  });
});

describe("parseScreens", () => {
  const quota = (overrides: Partial<ParsedQuota> = {}): ParsedQuota => ({
    provider: "t",
    plan: "u",
    weeklyPct: 1,
    resetsAt: "x",
    periodStart: "y",
    source: "tui",
    fetchedAt: "z",
    ...overrides,
  });

  it("returns the screen result when exact, parsing once", () => {
    const seen: string[] = [];
    const q = parseScreens("Weekly 1%", undefined, (cleaned) => {
      seen.push(cleaned);
      return quota();
    });
    expect(q.weeklyPct).toBe(1);
    expect(seen).toEqual(["Weekly 1%"]);
  });

  it("falls back to the soup when the screen throws", () => {
    const q = parseScreens("Weekly 26%\x1b[2Jwiped", undefined, (cleaned) => {
      const m = cleaned.match(/Weekly (\d+)%/);
      if (!m) throw new Error("nope");
      return quota({ weeklyPct: parseInt(m[1], 10) });
    });
    expect(q.weeklyPct).toBe(26);
  });

  it("upgrades an estimated screen result when the soup resolves exactly", () => {
    const q = parseScreens("A\x1b[2JB", undefined, (cleaned) =>
      cleaned === "B" || cleaned === " B" ? quota({ resetsAtEstimated: true }) : quota({}),
    );
    expect(q.resetsAtEstimated).toBeUndefined();
  });

  it("keeps the estimated screen result when the soup also fails", () => {
    const q = parseScreens("A\x1b[2JB", undefined, (cleaned) => {
      if (cleaned !== "AB") return quota({ weeklyPct: 7, resetsAtEstimated: true });
      throw new Error("soup bad");
    });
    expect(q.weeklyPct).toBe(7);
  });

  it("rethrows the screen error when both views are identical", () => {
    expect(() =>
      parseScreens("plain", undefined, () => {
        throw new Error("screen bad");
      }),
    ).toThrow("screen bad");
  });

  it("propagates the soup error when both throw and views differ", () => {
    expect(() =>
      parseScreens("A\x1b[2JB", undefined, (cleaned) => {
        throw new Error(`bad:${cleaned}`);
      }),
    ).toThrow("bad:AB");
  });
});

describe("cellWidth", () => {
  it("classifies ASCII, wide, and zero-width code points", () => {
    expect(cellWidth(0x41)).toBe(1);
    expect(cellWidth(0x2500)).toBe(1);
    expect(cellWidth(0x3042)).toBe(2);
    expect(cellWidth(0x4e2d)).toBe(2);
    expect(cellWidth(0x1f600)).toBe(2);
    expect(cellWidth(0x0301)).toBe(0);
    expect(cellWidth(0xfe0f)).toBe(0);
  });
});
