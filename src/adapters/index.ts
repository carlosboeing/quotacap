import { claudeAdapter } from "./claude.js";
import type { Adapter, Quota } from "./types.js";
export const adapters: Record<string, Adapter> = { claude: claudeAdapter as Adapter };
export async function pollAll(enabled: string[]){
  const jobs = enabled.map(id => {
    const a = adapters[id];
    if (!a) return Promise.reject(new Error(`unknown adapter ${id}`));
    return a.poll().then(v=>({provider:id,status:"fulfilled" as const, value:v})).catch(e=>({provider:id,status:"rejected" as const, reason:e}));
  });
  return Promise.all(jobs);
}
