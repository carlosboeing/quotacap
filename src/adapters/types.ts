export interface Quota {
  provider: string;
  plan: string;
  usedPct: number;
  sessionPct?: number;
  resetsAt: string;
  periodStart: string;
  source: "cli" | "api" | "scrape" | "manual" | "tui";
  fetchedAt: string;
  creditsUsd?: number;
  resetsAtEstimated?: boolean;
}

export interface ParsedQuota extends Quota {
  raw?: string;
}

export interface Adapter {
  id: string;
  requiresAuth: string;
  poll(): Promise<ParsedQuota | ParsedQuota[]>;
}

export const UNIMPLEMENTED = (id: string) => new Error(`${id} adapter not implemented — use manual-paste`);
