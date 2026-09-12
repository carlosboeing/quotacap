import { claudeAdapter } from "./claude.js";
import { manualAdapter } from "./manual.js";
import { codexAdapter } from "./codex.js";
import { kimiAdapter } from "./kimi.js";
import { grokAdapter } from "./grok.js";
import { agyAdapter } from "./agy.js";
import { museAdapter } from "./muse.js";
import { installAdapterSignal, clearAdapterSignal } from "../runtime/spawn.js";
import type { Adapter } from "./types.js";
export const adapters: Record<string, Adapter> = {
  claude: claudeAdapter,
  manual: manualAdapter as unknown as Adapter,
  codex: codexAdapter,
  kimi: kimiAdapter,
  grok: grokAdapter,
  agy: agyAdapter,
  muse: museAdapter,
};
const ADAPTER_TIMEOUTS: Record<string, number> = {
  claude: 8000,
  codex: 12000,
  kimi: 8000,
  grok: 14000,
  agy: 20000,
  muse: 14000,
};

export interface PollAllOptions {
  timeouts?: Record<string, number>;
}

export async function pollAll(enabled: string[], opts?: PollAllOptions){
  const rawJobs = enabled.map(id => {
    const a = adapters[id];
    if (!a) return Promise.reject(new Error(`unknown adapter ${id}`));
    // manual adapter has no poll capability — skip without degraded
    if (id === "manual") return Promise.reject(new Error("manual skipped"));
    const timeout = opts?.timeouts?.[id] ?? ADAPTER_TIMEOUTS[id] ?? 8000;
    // One controller per adapter: a timeout aborts only that adapter's
    // children; the signal clears when its job settles.
    const controller = new AbortController();
    installAdapterSignal(id, controller.signal);
    let p: Promise<unknown>;
    try {
      p = Promise.resolve(a.poll());
    } catch (e) {
      clearAdapterSignal(id);
      throw e;
    }
    const gated = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { controller.abort(); } catch {}
        reject(new Error(`timeout after ${timeout}ms`));
      }, timeout);
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
    return gated.finally(() => clearAdapterSignal(id));
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
