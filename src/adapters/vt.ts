// Minimal VT100/xterm screen renderer: replays a PTY transcript onto a
// cols×rows grid and returns the visible screen text. Cursor-addressed TUIs
// write fragments out of order ("Weekly lim" + CUP + "t (Tier)"); regexing
// the raw byte stream sees "Weekly limt", but the screen shows the truth.
// Parsing the rendered screen kills that whole artifact class (the 2026-09-28
// "Resets: October5, 10:22" grok failure was a cursor step over a blank cell,
// which the screen shows as a space and the byte stream drops entirely).
//
// Supported: CUP/HVP, CUU/CUD/CUF/CUB/CNL/CPL/CHA/VPA, ED, EL, IL/DL, DCH/ECH,
// SU/SD, DECSTBM scroll regions, SGR (ignored), alt-screen enter (clears),
// save/restore cursor (CSI s/u and DECSC/DECRC), RI/IND/NEL/HT/BS/CR/LF,
// OSC skip, RIS. Unknown sequences are ignored, never fatal.
import { stripAnsi } from "./pty.js";
import type { ParsedQuota } from "./types.js";

export interface GridDims {
  cols: number;
  rows: number;
}

export const DEFAULT_GRID_DIMS: GridDims = { cols: 140, rows: 50 };

// Approximate wcwidth: 0 for combining/format marks, 2 for wide ranges,
// 1 otherwise. Box drawing (U+2500-257F) and braille (U+2800-28FF) are
// width 1, which the fast path below gets right.
const ZERO_WIDTH: Array<readonly [number, number]> = [
  [0x0300, 0x036f],
  [0x0488, 0x0489],
  [0x0591, 0x05bd],
  [0x05bf, 0x05bf],
  [0x05c1, 0x05c2],
  [0x05c4, 0x05c5],
  [0x05c7, 0x05c7],
  [0x0610, 0x0617],
  [0x064b, 0x065b],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xe0100, 0xe01ef],
];

const WIDE: Array<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe52],
  [0xfe54, 0xfe66],
  [0xfe68, 0xfe6b],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe3],
  [0x17000, 0x187ec],
  [0x18800, 0x18af2],
  [0x1b000, 0x1b001],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0ff],
  [0x1f18e, 0x1f251],
  [0x1f300, 0x1f5ff],
  [0x1f600, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function inRanges(ranges: Array<readonly [number, number]>, cp: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid];
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

export function cellWidth(cp: number): 0 | 1 | 2 {
  if (cp < 0x0300 || (cp > 0xe01ef)) return 1;
  if (cp < 0x1100) return inRanges(ZERO_WIDTH, cp) ? 0 : 1;
  if (inRanges(ZERO_WIDTH, cp)) return 0;
  return inRanges(WIDE, cp) ? 2 : 1;
}

function blankRow(cols: number): Array<string | null> {
  return new Array<string | null>(cols).fill(" ");
}

function parseParams(body: string): { nums: number[]; private: boolean } {
  const priv = body.startsWith("?") || body.startsWith(">");
  const nums = body
    .replace(/^[?><=]/, "")
    .split(";")
    .map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
  return { nums, private: priv };
}

/** Render the final visible screen of a PTY transcript. */
export function renderScreen(transcript: string, dims?: Partial<GridDims>): string {
  const cols = Math.max(1, dims?.cols ?? DEFAULT_GRID_DIMS.cols);
  const rows = Math.max(1, dims?.rows ?? DEFAULT_GRID_DIMS.rows);
  const grid: Array<Array<string | null>> = [];
  for (let r = 0; r < rows; r++) grid.push(blankRow(cols));
  let x = 0;
  let y = 0;
  let savedX = 0;
  let savedY = 0;
  let scrollTop = 0;
  let scrollBottom = rows - 1;

  const clearAll = () => {
    for (let r = 0; r < rows; r++) grid[r] = blankRow(cols);
  };
  const scrollUp = (n: number) => {
    for (let i = 0; i < n; i++) {
      grid.splice(scrollTop, 1);
      grid.splice(scrollBottom, 0, blankRow(cols));
    }
  };
  const scrollDown = (n: number) => {
    for (let i = 0; i < n; i++) {
      grid.splice(scrollBottom, 1);
      grid.splice(scrollTop, 0, blankRow(cols));
    }
  };
  const lineFeed = () => {
    if (y >= scrollBottom) scrollUp(1);
    else y++;
  };
  const writeCell = (ch: string, w: 1 | 2) => {
    if (x + w > cols) {
      x = 0;
      lineFeed();
    }
    // A wide char straddling the right margin wraps instead of splitting.
    if (x + w > cols) return;
    grid[y][x] = ch;
    if (w === 2 && x + 1 < cols) grid[y][x + 1] = null;
    x += w;
    if (x >= cols) {
      x = 0;
      lineFeed();
    }
  };

  let i = 0;
  const n = transcript.length;
  while (i < n) {
    const c = transcript[i];
    if (c === "\x1b") {
      const next = transcript[i + 1];
      if (next === "[") {
        // CSI: params + intermediates + final byte.
        let j = i + 2;
        while (j < n) {
          const code = transcript.charCodeAt(j);
          if (code >= 0x40 && code <= 0x7e) break;
          j++;
        }
        if (j >= n) break; // Truncated sequence at kill time: stop.
        const body = transcript.slice(i + 2, j);
        const fin = transcript[j];
        i = j + 1;
        const { nums } = parseParams(body);
        const p1 = nums[0] || 1;
        switch (fin) {
          case "H":
          case "f": {
            const r = (nums[0] || 1) - 1;
            const col = (nums[1] || 1) - 1;
            y = Math.min(rows - 1, Math.max(0, r));
            x = Math.min(cols - 1, Math.max(0, col));
            break;
          }
          case "A":
            y = Math.max(0, y - p1);
            break;
          case "B":
            y = Math.min(rows - 1, y + p1);
            break;
          case "C":
            x = Math.min(cols - 1, x + p1);
            break;
          case "D":
            x = Math.max(0, x - p1);
            break;
          case "E":
            x = 0;
            y = Math.min(rows - 1, y + p1);
            break;
          case "F":
            x = 0;
            y = Math.max(0, y - p1);
            break;
          case "G":
            x = Math.min(cols - 1, Math.max(0, p1 - 1));
            break;
          case "d":
            y = Math.min(rows - 1, Math.max(0, p1 - 1));
            break;
          case "J": {
            const mode = nums[0] || 0;
            if (mode === 2 || mode === 3) {
              clearAll();
            } else if (mode === 1) {
              for (let r = 0; r < y; r++) grid[r] = blankRow(cols);
              for (let c0 = 0; c0 <= x && c0 < cols; c0++) grid[y][c0] = " ";
            } else {
              for (let c0 = x; c0 < cols; c0++) grid[y][c0] = " ";
              for (let r = y + 1; r < rows; r++) grid[r] = blankRow(cols);
            }
            break;
          }
          case "K": {
            const mode = nums[0] || 0;
            if (mode === 1) {
              for (let c0 = 0; c0 <= x && c0 < cols; c0++) grid[y][c0] = " ";
            } else if (mode === 2) {
              grid[y] = blankRow(cols);
            } else {
              for (let c0 = x; c0 < cols; c0++) grid[y][c0] = " ";
            }
            break;
          }
          case "L": {
            // Insert lines at cursor within the scroll region.
            const count = Math.min(p1, scrollBottom - y + 1);
            for (let k = 0; k < count; k++) {
              grid.splice(scrollBottom, 1);
              grid.splice(Math.max(scrollTop, y), 0, blankRow(cols));
            }
            break;
          }
          case "M": {
            // Delete lines at cursor within the scroll region.
            const count = Math.min(p1, scrollBottom - y + 1);
            for (let k = 0; k < count; k++) {
              grid.splice(Math.max(scrollTop, y), 1);
              grid.splice(scrollBottom, 0, blankRow(cols));
            }
            break;
          }
          case "P": {
            // Delete characters at cursor.
            const count = Math.min(p1, cols - x);
            grid[y].splice(x, count);
            while (grid[y].length < cols) grid[y].push(" ");
            break;
          }
          case "@": {
            // Insert blank characters at cursor.
            const count = Math.min(p1, cols - x);
            grid[y].splice(x, 0, ...blankRow(count));
            grid[y].length = cols;
            break;
          }
          case "X": {
            // Erase characters at cursor.
            const count = Math.min(p1, cols - x);
            for (let c0 = x; c0 < x + count; c0++) grid[y][c0] = " ";
            break;
          }
          case "S":
            scrollUp(Math.min(p1, scrollBottom - scrollTop + 1));
            break;
          case "T":
            scrollDown(Math.min(p1, scrollBottom - scrollTop + 1));
            break;
          case "r": {
            // DECSTBM scroll region (1-based, inclusive).
            const top = Math.max(1, nums[0] || 1);
            const bottom = nums[1] || rows;
            if (top <= bottom && top <= rows) {
              scrollTop = Math.min(rows - 1, top - 1);
              scrollBottom = Math.min(rows - 1, bottom - 1);
            }
            x = 0;
            y = scrollTop;
            break;
          }
          case "s":
            savedX = x;
            savedY = y;
            break;
          case "u":
            x = Math.min(cols - 1, savedX);
            y = Math.min(rows - 1, savedY);
            break;
          case "h":
          case "l": {
            // Alt-screen enter wipes to a fresh buffer; its exit cannot
            // restore the main screen, so it is a no-op. All other private
            // modes (cursor visibility, mouse, sync output) are ignored.
            if (fin === "h" && /(?:^|;)1049(?:;|$)/.test(body.replace(/^[?><=]/, ""))) {
              clearAll();
              x = 0;
              y = 0;
            }
            break;
          }
          default:
            break; // SGR (m), queries (c/n), tabs, colors: no screen effect.
        }
        continue;
      }
      if (next === "]") {
        // OSC: skip to BEL or ST.
        let j = i + 2;
        while (j < n) {
          if (transcript[j] === "\x07") {
            j++;
            break;
          }
          if (transcript[j] === "\x1b" && transcript[j + 1] === "\\") {
            j += 2;
            break;
          }
          j++;
        }
        i = j;
        continue;
      }
      if (next === "7") {
        savedX = x;
        savedY = y;
        i += 2;
        continue;
      }
      if (next === "8") {
        x = Math.min(cols - 1, savedX);
        y = Math.min(rows - 1, savedY);
        i += 2;
        continue;
      }
      if (next === "M") {
        // Reverse index.
        if (y <= scrollTop) scrollDown(1);
        else y--;
        i += 2;
        continue;
      }
      if (next === "D") {
        lineFeed();
        i += 2;
        continue;
      }
      if (next === "E") {
        x = 0;
        lineFeed();
        i += 2;
        continue;
      }
      if (next === "c") {
        clearAll();
        x = 0;
        y = 0;
        scrollTop = 0;
        scrollBottom = rows - 1;
        i += 2;
        continue;
      }
      if (next === "(" || next === ")" || next === "#" || next === "=" || next === ">") {
        i += 2; // Charset selects, keypad modes: no screen effect.
        continue;
      }
      // Unknown ESC sequence: skip the introducer, keep scanning.
      i += next === undefined ? 1 : 2;
      continue;
    }
    if (c === "\r") {
      x = 0;
      i++;
      continue;
    }
    if (c === "\n") {
      // NEL-style: PTY output carries \r\n (ONLCR) so the \r already ran;
      // plain fixtures carry bare \n and expect a fresh line start.
      x = 0;
      lineFeed();
      i++;
      continue;
    }
    if (c === "\b") {
      x = Math.max(0, x - 1);
      i++;
      continue;
    }
    if (c === "\t") {
      x = Math.min(cols - 1, x + 8 - (x % 8));
      i++;
      continue;
    }
    const code = transcript.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      i++; // Other C0 controls (BEL etc.): no screen effect.
      continue;
    }
    const cp = transcript.codePointAt(i) ?? code;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    const w = cellWidth(cp);
    if (w === 0) continue;
    writeCell(ch, w);
  }

  const lines: string[] = [];
  for (const row of grid) {
    let end = row.length;
    while (end > 0 && (row[end - 1] === "" || row[end - 1] === null || row[end - 1] === " ")) end--;
    lines.push(row.slice(0, end).map((cell) => (cell === null ? "" : cell)).join(""));
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/**
 * Screen-first parsing with byte-soup fallback. The rendered screen is
 * precise (overwrite artifacts resolved) but lossy in one case: a TUI that
 * leaves alt-screen and clears on kill wipes the dialog the transcript
 * captured earlier (observed: grok prints a resume line on exit). The
 * cumulative soup never loses content but keeps cursor artifacts. So: parse
 * the screen; on throw, or on an estimated reset the soup resolves exactly,
 * parse the soup instead. Worst case equals the old soup-only behavior.
 */
export function parseScreens(
  text: string,
  dims: Partial<GridDims> | undefined,
  parse: (cleaned: string) => ParsedQuota,
): ParsedQuota {
  const screen = renderScreen(text, dims);
  try {
    const first = parse(screen);
    if (!first.resetsAtEstimated) return first;
    const soup = stripAnsi(text);
    if (soup === screen) return first;
    try {
      const second = parse(soup);
      return second.resetsAtEstimated ? first : second;
    } catch {
      return first;
    }
  } catch (screenErr) {
    const soup = stripAnsi(text);
    if (soup === screen) throw screenErr;
    return parse(soup);
  }
}
