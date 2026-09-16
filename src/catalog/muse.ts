import fs from "node:fs";
import { runPty, stripAnsi } from "../adapters/pty.js";
import { museProbeDir } from "../adapters/muse.js";
import type { CatalogFetcher, ListedModel } from "./types.js";

// Muse TUI `/model` picker (design §6.6). The statusline shows the current
// model (`muse-spark-1.3·max`) before the picker opens, so ids are collected
// only from the slice after the first "Choose model". The statusline id marks
// `default` when it also appears in the picker.
export function parseMuseModelPicker(transcript: string): ListedModel[] {
  const cleaned = stripAnsi(transcript);
  const m = /Choose\s*model/i.exec(cleaned);
  if (!m) throw new Error("muse: no model picker (Choose model) in transcript");
  const after = cleaned.slice(m.index + m[0].length);
  const ids: string[] = [];
  for (const im of after.matchAll(/muse-spark-[\w.-]+/g)) {
    if (!ids.includes(im[0])) ids.push(im[0]);
  }
  if (ids.length === 0) throw new Error("muse: no muse-spark ids after the model picker");
  const statusline = /muse-spark-[\w.-]+/.exec(cleaned.slice(0, m.index));
  const statusId = statusline ? statusline[0] : null;
  return ids.map((id) => {
    const entry: ListedModel = { id, displayName: id };
    if (statusId !== null && id === statusId) entry.default = true;
    return entry;
  });
}

export const MUSE_OVERALL_MS = 28_000;

export const museCatalogFetcher: CatalogFetcher = {
  id: "muse",
  async fetch() {
    const cwd = museProbeDir();
    fs.mkdirSync(cwd, { recursive: true });
    // Catalog-owned overall abort (28s). Phase timers inside runPty are
    // separate; this signal kills the child if everything combined exceeds
    // the budget. Never the usage-poll shared controller.
    const transcript = await runPty({
      file: "muse",
      args: ["--trust-workspace"],
      cwd,
      env: { MUSE_NO_AUTO_UPDATE: "1" },
      cols: 140,
      rows: 50,
      readyRegex: /muse-spark|Muse Code \d/,
      readyTimeoutMs: 8000,
      settleDelayMs: 1000,
      input: "/model",
      submitInput: "\r",
      submitAfterMs: 1500,
      completionRegex: /Choose\s*model/i,
      abortOn:
        /Do you trust this workspace|Working \(\d+s|Subscriptions aren't currently available|subscription_unavailable/,
      timeoutMs: 14000,
      respondToQueries: true,
      maxBytes: 256 * 1024,
      signal: AbortSignal.timeout(MUSE_OVERALL_MS),
      label: "muse-catalog",
    });
    try {
      return { muse: parseMuseModelPicker(transcript) };
    } catch (e) {
      throw new Error(`muse: failed to parse /model picker: ${(e as Error)?.message ?? e}`);
    }
  },
};
