import type { StateSnapshot } from "./state.js";

/** The daemon serves the dashboard, so the state endpoint is same-origin. */
export function daemonEndpoint(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}/api/state`;
  }
  return "/api/state";
}

/** Network failure reaching the daemon: render the service-unavailable panel. */
export class StateNetworkError extends Error {
  readonly endpoint: string;
  constructor(endpoint: string, cause?: unknown) {
    super(`service unavailable: ${endpoint}`);
    this.name = "StateNetworkError";
    this.endpoint = endpoint;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** HTTP error from the daemon: render status code plus the server's message. */
export class StateHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "StateHttpError";
    this.status = status;
  }
}

async function serverMessage(r: Response): Promise<string> {
  try {
    const body: unknown = await r.json();
    if (body !== null && typeof body === "object") {
      for (const key of ["error", "message", "reason"]) {
        const value = (body as Record<string, unknown>)[key];
        if (typeof value === "string" && value.length > 0) return value;
      }
    }
  } catch {
    // Fall through to status text below.
  }
  return r.statusText || `HTTP ${r.status}`;
}

/** Single state fetch. No legacy-endpoint fallback: unreachable means unavailable. */
export async function loadState(): Promise<StateSnapshot> {
  let r: Response;
  try {
    r = await fetch("/api/state");
  } catch (e) {
    throw new StateNetworkError("/api/state", e);
  }
  if (!r.ok) throw new StateHttpError(r.status, await serverMessage(r));
  return (await r.json()) as StateSnapshot;
}

export async function fetchToken(): Promise<string> {
  let r: Response;
  try {
    r = await fetch("/api/token");
  } catch (e) {
    throw new StateNetworkError("/api/token", e);
  }
  if (!r.ok) throw new StateHttpError(r.status, await serverMessage(r));
  const data = (await r.json()) as { token: string };
  return data.token;
}

export interface RefreshResult {
  ok: boolean;
  status: number;
  /** Server cooldown/in-progress info, verbatim when the server sends it. */
  message: string | null;
  raw: unknown;
}

/** First server-sent message string, or null when the server sent none. */
export function refreshMessage(body: unknown): string | null {
  if (body !== null && typeof body === "object") {
    for (const key of ["message", "error", "reason"]) {
      const value = (body as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return null;
}

export interface IngestResult {
  ok: boolean;
  status: number;
  /** Server message verbatim when the server sends one. */
  message: string | null;
  raw: unknown;
}

/**
 * Manual usage ingest. The input text is sent unparsed; the server validates
 * and stores it. Server validation errors surface verbatim via StateHttpError.
 */
export async function postIngest(provider: string, text: string): Promise<IngestResult> {
  const token = await fetchToken();
  let r: Response;
  try {
    r = await fetch("/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-QuotaCap-Token": token },
      body: JSON.stringify({ provider, text }),
    });
  } catch (e) {
    throw new StateNetworkError("/api/ingest", e);
  }
  let raw: unknown = null;
  try {
    raw = await r.json();
  } catch {
    raw = null;
  }
  if (!r.ok) throw new StateHttpError(r.status, refreshMessage(raw) ?? r.statusText ?? `HTTP ${r.status}`);
  return { ok: r.ok, status: r.status, message: refreshMessage(raw), raw };
}

/** Manual refresh. Callers preserve prior readings when this throws. */
export async function triggerRefresh(): Promise<RefreshResult> {
  const token = await fetchToken();
  let r: Response;
  try {
    r = await fetch("/api/refresh", {
      method: "POST",
      headers: { "X-QuotaCap-Token": token },
    });
  } catch (e) {
    throw new StateNetworkError("/api/refresh", e);
  }
  let raw: unknown = null;
  try {
    raw = await r.json();
  } catch {
    raw = null;
  }
  if (!r.ok) throw new StateHttpError(r.status, refreshMessage(raw) ?? r.statusText ?? `HTTP ${r.status}`);
  return { ok: r.ok, status: r.status, message: refreshMessage(raw), raw };
}
