import { stripAnsi } from "../adapters/pty.js";
import type { ListedModel } from "./types.js";

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
