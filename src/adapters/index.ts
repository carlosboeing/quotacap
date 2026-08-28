import { claudeAdapter } from "./claude.js";
import { manualAdapter } from "./manual.js";
import type { Adapter } from "./types.js";
export const adapters: Record<string, Adapter> = {
  claude: claudeAdapter as Adapter,
  manual: manualAdapter as unknown as Adapter,
};
export async function pollAll(enabled: string[]){
  const jobs = enabled.map(id => {
    const a = adapters[id];
    if (!a) return Promise.resolve({provider:id,status:"rejected" as const, reason:new Error(`unknown adapter ${id}`)});
    return a.poll().then(v=>({provider:id,status:"fulfilled" as const, value:v})).catch(e=>({provider:id,status:"rejected" as const, reason:e}));
  });
  return Promise.all(jobs);
}
