import { claudeAdapter } from "./claude.js";
import { manualAdapter } from "./manual.js";
import type { Adapter } from "./types.js";
export const adapters: Record<string, Adapter> = {
  claude: claudeAdapter as Adapter,
  manual: manualAdapter as unknown as Adapter,
};
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms))]);
}
export async function pollAll(enabled: string[]){
  const rawJobs = enabled.map(id => {
    const a = adapters[id];
    if (!a) return Promise.reject(new Error(`unknown adapter ${id}`));
    return withTimeout(a.poll(), 8000);
  });
  const settled = await Promise.allSettled(rawJobs);
  return settled.map((s, i) => {
    const id = enabled[i];
    if (s.status === "fulfilled") return { provider: id, status: "fulfilled" as const, value: s.value };
    return { provider: id, status: "rejected" as const, reason: s.reason };
  });
}
