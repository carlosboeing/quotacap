// Service HTTP client: shared by `web` now, D-owned commands later.
export class ServiceUnavailable extends Error {
  constructor(message = "service unavailable") {
    super(message);
    this.name = "ServiceUnavailable";
  }
}

export class ServiceError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`service error ${status}: ${body.slice(0, 200)}`);
    this.name = "ServiceError";
    this.status = status;
    this.body = body;
  }
}

export interface ServiceClientOptions {
  port: number;
  host?: string;
  token?: string;
  timeoutMs?: number;
}

export interface ServiceClient {
  get(path: string): Promise<any>;
  post(path: string, body?: unknown): Promise<any>;
}

export function createServiceClient(opts: ServiceClientOptions): ServiceClient {
  const host = opts.host ?? "127.0.0.1";
  const timeoutMs = opts.timeoutMs ?? 2000;
  const base = `http://${host}:${opts.port}`;

  async function parse(res: Response): Promise<any> {
    const text = await res.text();
    if (!res.ok) throw new ServiceError(res.status, text);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  }

  async function get(path: string): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (e instanceof ServiceError) throw e;
      throw new ServiceUnavailable(
        `service unavailable at ${base}: ${(e as Error)?.message ?? String(e)}`,
      );
    }
    return parse(res);
  }

  async function post(path: string, body?: unknown): Promise<any> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.token) headers["x-quotacap-token"] = opts.token;
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e instanceof ServiceError) throw e;
      throw new ServiceUnavailable(
        `service unavailable at ${base}: ${(e as Error)?.message ?? String(e)}`,
      );
    }
    return parse(res);
  }

  return { get, post };
}
