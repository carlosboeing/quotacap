export interface Quota {
  provider: string; plan: string; usedPct: number; sessionPct?: number;
  resetsAt: string; periodStart: string; raw: string; source: "cli"|"api"|"scrape"|"manual"; fetchedAt: string;
}
export interface Adapter { id: string; requiresAuth: string; poll(): Promise<Quota>; }
export const UNIMPLEMENTED = (id:string) => new Error(`${id} adapter not implemented — use manual-paste`);
