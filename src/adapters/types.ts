export interface Quota {
  provider: string;
  plan: string;
  /** The paced window. 0..100. Named `usedPct` before this release. */
  weeklyPct: number;
  /** 5-hour rolling window. 0..100. Display only — never ranks. Was `sessionPct`. */
  fiveHourPct?: number;
  /** Included monthly envelope. 0..100. Absent means the provider has no monthly window. */
  monthlyPct?: number;
  monthlyResetsAt?: string;
  monthlyStatus?: "ok" | "exhausted";
  /** "included" only this slice. A spend cap or PAYG ceiling will carry its own value. */
  monthlyKind?: "included";
  resetsAt: string;
  periodStart: string;
  source: "cli" | "api" | "scrape" | "manual" | "tui";
  fetchedAt: string;
  creditsUsd?: number;
  resetsAtEstimated?: boolean;
}

/** Store and wire shape: `Quota` plus the one-release aliases. */
export interface QuotaWire extends Quota {
  /** @deprecated alias for weeklyPct. Removed the release after next. */
  usedPct: number;
  /** @deprecated alias for fiveHourPct. Removed the release after next. */
  sessionPct?: number;
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
