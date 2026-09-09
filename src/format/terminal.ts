// Terminal renderers: wide and narrow tables plus the ASCII-only compact
// statusline. Width selects the renderer (the caller resolves TTY/pipe);
// these functions format rows and never recompute ranking or pace.
import type { StateSnapshot } from "../advisory/types.js";
import {
  buildRow,
  compactSuffix,
  sortProviders,
  type RailCell,
  type SortKey,
  type StateWord,
} from "./rows.js";

export interface RenderOptions {
  now: Date;
  ascii?: boolean;
  color?: boolean;
  sort?: SortKey;
}

const GAP = "  ";
const MIN_PROV_WIDTH = 12;
const MAX_PROV_WIDTH = 22;

interface Glyphs {
  fill: string;
  tick: string;
  unused: string;
  sep: string;
  dash: string;
  star: string;
  ellipsis: string;
}

const UNICODE: Glyphs = {
  fill: "█",
  tick: "│",
  unused: "░",
  sep: "·",
  dash: "—",
  star: "★",
  ellipsis: "…",
};

const ASCII: Glyphs = {
  fill: "#",
  tick: "|",
  unused: ":",
  sep: "-",
  dash: "-",
  star: "*",
  ellipsis: "+",
};

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD_WHITE = "\x1b[1;37m";
const STAR = "\x1b[1;35m";
const STATE_COLORS: Record<StateWord, string> = {
  "On track": "\x1b[32m",
  "Behind pace": "\x1b[33m",
  "Ahead of pace": "\x1b[93m",
  "Cap risk": "\x1b[31m",
  "Not reporting": "\x1b[90m",
};

// provWidth covers the 2-char prefix plus name, measured before ANSI.
export function provWidthFor(ids: string[]): number {
  const longest = ids.reduce((m, id) => Math.max(m, 2 + id.length), 0);
  return Math.min(MAX_PROV_WIDTH, Math.max(MIN_PROV_WIDTH, longest));
}

function rawProviderField(id: string, recommended: boolean, width: number, g: Glyphs): string {
  const raw = (recommended ? `${g.star} ` : "  ") + id;
  const clipped = raw.length > width ? raw.slice(0, width - 1) + g.ellipsis : raw;
  return clipped + " ".repeat(Math.max(0, width - clipped.length));
}

function colorProviderField(field: string, recommended: boolean, state: StateWord): string {
  if (!recommended) return `${STATE_COLORS[state]}${field}${RESET}`;
  return `${STAR}${field.slice(0, 2)}${RESET}${STATE_COLORS[state]}${field.slice(2)}${RESET}`;
}

function renderRail(cells: RailCell[], g: Glyphs, state: StateWord, color: boolean): string {
  const glyph = (c: RailCell): string => (c === "used" ? g.fill : c === "tick" ? g.tick : g.unused);
  if (!color) return cells.map(glyph).join("");
  let out = "";
  let i = 0;
  while (i < cells.length) {
    let j = i;
    while (j < cells.length && cells[j] === cells[i]) j++;
    const run = cells.slice(i, j).map(glyph).join("");
    const code = cells[i] === "used" ? STATE_COLORS[state] : cells[i] === "tick" ? BOLD_WHITE : DIM;
    out += `${code}${run}${RESET}`;
    i = j;
  }
  return out;
}

function asciiText(s: string): string {
  return s.replace(/·/g, "-").replace(/—/g, "-");
}

export function renderWide(snapshot: StateSnapshot, opts: RenderOptions): string {
  const g = opts.ascii ? ASCII : UNICODE;
  const color = !!opts.color && !opts.ascii;
  const use = snapshot.recommendation.use;
  const sorted = sortProviders(snapshot.providers, opts.sort ?? "recommended", use);
  const width = provWidthFor(snapshot.providers.map((p) => p.id));
  const paint = (s: string, code: string): string => (color ? `${code}${s}${RESET}` : s);
  const header = [
    "PROVIDER".padEnd(width),
    "USED".padStart(6),
    "ELAPSED".padStart(8),
    "USED VS TIME".padEnd(20),
    "RESETS".padEnd(9),
    "STATE".padEnd(15),
    "FORECAST",
  ].join(GAP);
  const lines = sorted.map((p) => {
    const row = buildRow(p, opts.now);
    const recommended = p.id === use && use !== "none";
    const name = rawProviderField(p.id, recommended, width, g);
    const used = (row.usedPct === null ? g.dash : `${row.usedPct}%`).padStart(6);
    const elapsed = (row.elapsedPct === null ? g.dash : `${row.elapsedPct}%`).padStart(8);
    const rail = renderRail(row.railCells, g, row.state, color);
    const countdown = (opts.ascii ? asciiText(row.countdown) : row.countdown).padEnd(9);
    const state = row.state.padEnd(15);
    const forecast = opts.ascii ? asciiText(row.forecast) : row.forecast;
    return [
      color ? colorProviderField(name, recommended, row.state) : name,
      used,
      elapsed,
      rail,
      countdown,
      paint(state, STATE_COLORS[row.state]),
      forecast,
    ].join(GAP);
  });
  return [paint(header, DIM), ...lines].join("\n");
}

export function renderNarrow(snapshot: StateSnapshot, opts: RenderOptions): string {
  const g = opts.ascii ? ASCII : UNICODE;
  const color = !!opts.color && !opts.ascii;
  const use = snapshot.recommendation.use;
  const sorted = sortProviders(snapshot.providers, opts.sort ?? "recommended", use);
  const width = provWidthFor(snapshot.providers.map((p) => p.id));
  const lines: string[] = [];
  for (const p of sorted) {
    const row = buildRow(p, opts.now);
    const recommended = p.id === use && use !== "none";
    const name = rawProviderField(p.id, recommended, width, g);
    const used = row.usedPct === null ? g.dash : `${row.usedPct}%`;
    const elapsed = row.elapsedPct === null ? g.dash : `${row.elapsedPct}%`;
    const rail = renderRail(row.railCells, g, row.state, color);
    const countdown = opts.ascii ? asciiText(row.countdown) : row.countdown;
    const forecast = opts.ascii ? asciiText(row.forecast) : row.forecast;
    const state = color ? `${STATE_COLORS[row.state]}${row.state}${RESET}` : row.state;
    lines.push(
      `${color ? colorProviderField(name, recommended, row.state) : name} ${used} used ${g.sep} ${elapsed} elapsed`,
      `${rail} resets ${countdown} ${g.sep} ${state} ${g.sep} ${forecast}`,
    );
  }
  return lines.join("\n");
}

// Always ASCII, never ANSI, even on a TTY: prompt-safe by construction.
// Takes the fixed clock for signature parity; compact shows no ages.
export function renderCompact(snapshot: StateSnapshot, _now?: Date): string {
  void _now;
  const use = snapshot.recommendation.use;
  const sorted = sortProviders(snapshot.providers, "recommended", use);
  const entries = sorted
    .filter((p) => p.quota !== null)
    .map((p) => {
      const u = p.quota?.usedPct;
      const used = typeof u === "number" && Number.isFinite(u) ? String(Math.round(u)) : "?";
      return `[${p.id}:${used}%${compactSuffix(p)}]`;
    });
  if (entries.length === 0) return "(use: none)";
  return `${entries.join(" | ")}  (use: ${use})`;
}
