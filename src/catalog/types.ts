export type CatalogStatus = "ok" | "stale" | "error" | "unfetched";

export interface ListedModel {
  id: string;
  displayName: string;
  default?: boolean;
  efforts?: string[];
}

export interface CatalogView {
  status: CatalogStatus;
  fetchedAt: string | null;
  listed: ListedModel[];
  diagnosticCode?: string | null;
  summary?: string | null;
  action?: string | null;
}

export interface CatalogFetcher {
  /** Harness binary / usage adapter id: claude, codex, kimi, grok, agy, muse. */
  id: string;
  fetch(): Promise<Record<string, ListedModel[]>>;
}

export function emptyCatalog(): CatalogView {
  return { status: "unfetched", fetchedAt: null, listed: [] };
}
