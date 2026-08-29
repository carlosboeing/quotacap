import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJsonFile, postForm, getJson, persistCreds, HttpError } from "../../src/adapters/core.js";

const dir = () => fs.mkdtemp(path.join(os.tmpdir(), "qc-core-"));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = ((url: string, init: RequestInit) => {
    const r = handler(url, init);
    seen = {
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? init.body : "",
    };
    return r;
  }) as typeof fetch;
}

describe("readJsonFile", () => {
  it("returns parsed JSON", async () => {
    const d = await dir();
    const f = path.join(d, "a.json");
    await fs.writeFile(f, JSON.stringify({ a: 1 }));
    expect(await readJsonFile(f)).toEqual({ a: 1 });
  });

  it("throws when the file is missing", async () => {
    await expect(readJsonFile("/nonexistent/nope.json")).rejects.toThrow();
  });
});

describe("postForm", () => {
  it("sends form-encoded fields and returns parsed JSON", async () => {
    stubFetch(() => jsonResponse(200, { access_token: "tok123" }));
    const out = await postForm("https://auth.example.com/token", {
      grant_type: "refresh_token",
      refresh_token: "rf-tok",
      client_id: "c1",
    });
    expect(out).toEqual({ access_token: "tok123" });
    expect(seen?.url).toBe("https://auth.example.com/token");
    expect(seen?.body).toContain("grant_type=refresh_token");
    expect(seen?.body).toContain("refresh_token=rf-tok");
  });

  it("throws HttpError with status on non-2xx", async () => {
    stubFetch(() => jsonResponse(401, { error: "bad" }));
    await expect(postForm("https://auth.example.com/token", { grant_type: "refresh_token" })).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe("getJson", () => {
  it("returns parsed JSON on 200", async () => {
    stubFetch(() => jsonResponse(200, { used: 17 }));
    const out = await getJson("https://api.example.com/usages", { Authorization: "Bearer t" });
    expect(out).toEqual({ used: 17 });
  });

  it("throws HttpError carrying the status on 401", async () => {
    stubFetch(() => jsonResponse(401, { error: "expired" }));
    const err = await getJson("https://api.example.com/usages", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
  });
});

describe("persistCreds", () => {
  it("writes an updated file and takes a one-time .qc-bak copy", async () => {
    const d = await dir();
    const f = path.join(d, "creds.json");
    await fs.writeFile(f, JSON.stringify({ access_token: "old", refresh_token: "rf" }));

    const first = await persistCreds(f, (cur: Record<string, unknown>) => ({ ...cur, access_token: "new1" }));
    expect(first).toBe(true);
    const written = JSON.parse(await fs.readFile(f, "utf8")) as Record<string, unknown>;
    expect(written).toEqual({ access_token: "new1", refresh_token: "rf" });

    const bak = JSON.parse(await fs.readFile(path.join(d, "creds.json.qc-bak"), "utf8")) as Record<string, unknown>;
    expect(bak).toEqual({ access_token: "old", refresh_token: "rf" });

    const second = await persistCreds(f, (cur: Record<string, unknown>) => ({ ...cur, access_token: "new2" }));
    expect(second).toBe(false);
    const stillBak = JSON.parse(await fs.readFile(path.join(d, "creds.json.qc-bak"), "utf8")) as Record<string, unknown>;
    expect(stillBak.access_token).toBe("old");
  });
});
