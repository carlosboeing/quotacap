import { getCatalog, getCatalogs, upsertCatalog, markCatalogFailure } from "../store/catalogs.js";
import { emptyCatalog, type CatalogFetcher, type CatalogView, type ListedModel } from "./types.js";
import { agyCatalogFetcher } from "./agy.js";
import { claudeCatalogFetcher } from "./claude.js";
import { codexCatalogFetcher } from "./codex.js";
import { grokCatalogFetcher } from "./grok.js";
import { kimiCatalogFetcher } from "./kimi.js";
import { museCatalogFetcher } from "./muse.js";

export const CATALOG_CLIENT_TIMEOUT_MS = 30_000;
export { MUSE_OVERALL_MS } from "./muse.js";
export const CATALOG_FAIL_COOLDOWN_MS = 60_000;

// Fetcher map keyed by harness binary id. `agy:3p` resolves to the `agy`
// fetcher (one spawn writes both rows).
export const catalogFetchers: Record<string, CatalogFetcher> = {
  agy: agyCatalogFetcher,
  claude: claudeCatalogFetcher,
  codex: codexCatalogFetcher,
  grok: grokCatalogFetcher,
  kimi: kimiCatalogFetcher,
  muse: museCatalogFetcher,
};

// In-process state: coalescing in-flight fetches and failure cooldown.
// Both reset on process restart (no SQLite column).
const inFlight = new Map<string, Promise<Record<string, ListedModel[]>>>();
const lastFailAt = new Map<string, number>();

// Provider ids that share a fetcher. `agy:3p` → `agy`. Others map to
// themselves. Unknown ids get no fetcher.
function fetcherKeyFor(provider: string): string {
  if (provider === "agy:3p") return "agy";
  return provider;
}

// Both agy buckets that a single `agy` fetch produces.
const AGY_BUCKETS: readonly string[] = ["agy", "agy:3p"];

function bucketsForFetcher(fetcherKey: string): readonly string[] {
  if (fetcherKey === "agy") return AGY_BUCKETS;
  return [fetcherKey];
}

export interface EnsureCatalogsOpts {
  db: any;
  wait: boolean;
  refresh?: boolean;
  providers: string[];
  ttlHours: number;
  now?: () => Date;
  fetchers?: Record<string, CatalogFetcher>;
}

function needsFetch(
  view: CatalogView,
  ttlHours: number,
  refresh: boolean,
  fetcherKey: string,
  nowMs: number,
): boolean {
  // Missing / never fetched.
  if (view.status === "unfetched") return true;

  // Stale or error: retry if forced, cooldown elapsed, or no cooldown armed
  // (process restart). Cooldown is process-memory only. Check before TTL:
  // an error row with null fetchedAt must still respect cooldown.
  if (view.status === "stale" || view.status === "error") {
    if (refresh) return true;
    const failTs = lastFailAt.get(fetcherKey);
    if (failTs == null) return true;
    return nowMs - failTs >= CATALOG_FAIL_COOLDOWN_MS;
  }

  // TTL expired.
  if (view.fetchedAt != null) {
    const age = nowMs - Date.parse(view.fetchedAt);
    if (age > ttlHours * 3600_000) return true;
  } else {
    return true; // no fetchedAt is treated as expired
  }

  // Forced refresh.
  if (refresh) return true;

  return false;
}

export async function ensureCatalogs(opts: EnsureCatalogsOpts): Promise<Map<string, CatalogView>> {
  const { db, wait, refresh = false, providers, ttlHours, now = () => new Date() } = opts;
  const fetchers = opts.fetchers ?? catalogFetchers;
  const result = new Map<string, CatalogView>();

  if (!wait) {
    for (const p of providers) {
      result.set(p, getCatalog(db, p));
    }
    return result;
  }

  // Deduplicate providers to the fetcher key level.
  const seenKeys = new Set<string>();
  const toFetch = new Map<string, CatalogFetcher>();
  const providerToKey = new Map<string, string>();

  for (const p of providers) {
    const key = fetcherKeyFor(p);
    providerToKey.set(p, key);

    if (p === "manual" || seenKeys.has(key)) continue;
    seenKeys.add(key);

    const fetcher = fetchers[key];
    if (!fetcher) continue;

    // Read the primary bucket to decide whether a fetch is needed.
    const view = getCatalog(db, key);
    const nowMs = now().getTime();
    if (needsFetch(view, ttlHours, refresh, key, nowMs)) {
      toFetch.set(key, fetcher);
    }
  }

  // Launch fetches in parallel, coalescing with any already in-flight.
  const pending: Array<{ key: string; promise: Promise<Record<string, ListedModel[]>> }> = [];

  for (const [key, fetcher] of toFetch) {
    let p = inFlight.get(key);
    if (!p) {
      p = fetcher.fetch();
      inFlight.set(key, p);
      // Clean up in-flight on settle (success or failure).
      p.then(
        () => inFlight.delete(key),
        () => inFlight.delete(key),
      );
    }
    pending.push({ key, promise: p });
  }

  // Wait for all fetches.
  const settled = await Promise.allSettled(pending.map((e) => e.promise));

  for (let i = 0; i < pending.length; i++) {
    const { key } = pending[i];
    const outcome = settled[i];
    const buckets = bucketsForFetcher(key);
    const nowIso = now().toISOString();

    if (outcome.status === "fulfilled") {
      const lists = outcome.value;
      for (const bucket of buckets) {
        const listed = lists[bucket] ?? [];
        upsertCatalog(db, bucket, listed, nowIso);
      }
    } else {
      const err = outcome.reason;
      lastFailAt.set(key, now().getTime());
      for (const bucket of buckets) {
        markCatalogFailure(db, bucket, {
          diagnosticCode: err?.code ?? "fetch_error",
          summary: String(err?.message ?? err).slice(0, 500),
          action: "retry",
          errorDetail: String(err?.stack ?? err).slice(0, 2000),
        });
      }
    }
  }

  // Read final state for all requested providers.
  for (const p of providers) {
    result.set(p, getCatalog(db, p));
  }

  return result;
}
