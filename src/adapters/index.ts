import { claudeAdapter } from "./claude.js";
import { manualAdapter } from "./manual.js";
import { codexAdapter } from "./codex.js";
import { kimiAdapter } from "./kimi.js";
import { grokAdapter } from "./grok.js";
import type { Adapter } from "./types.js";
export const adapters: Record<string, Adapter> = {
  claude: claudeAdapter as Adapter,
  manual: manualAdapter as unknown as Adapter,
  codex: codexAdapter,
  kimi: kimiAdapter,
  grok: grokAdapter,
};
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}
export async function pollAll(enabled: string[]){
  const rawJobs = enabled.map(id => {
    const a = adapters[id];
    if (!a) return Promise.reject(new Error(`unknown adapter ${id}`));
    // manual adapter has no poll capability — skip without degraded
    if (id === "manual") return Promise.reject(new Error("manual skipped — use ingest"));
    return withTimeout(a.poll(), 8000);
  });
  const settled = await Promise.allSettled(rawJobs);
  return settled.map((s, i) => {
    const id = enabled[i];
    if (s.status === "fulfilled") return { provider: id, status: "fulfilled" as const, value: s.value };
    const msg = String((s.reason as any)?.message ?? s.reason);
    if (msg.includes("manual skipped")) return { provider: id, status: "skipped" as const, reason: s.reason };
    return { provider: id, status: "rejected" as const, reason: s.reason };
  });
}
