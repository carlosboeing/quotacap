import fs from "node:fs/promises";

export class HttpError extends Error {
  constructor(public status: number, public body: string) {
    super(`HTTP ${status}: ${String(body).slice(0, 120)}`);
  }
}

export async function readJsonFile<T>(file: string): Promise<T> {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw) as T;
}

async function parseResponse(res: Response): Promise<any> {
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function postForm(
  url: string,
  fields: Record<string, string>,
  extraHeaders: Record<string, string> = {},
  timeoutMs = 8000
): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...extraHeaders },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return parseResponse(res);
}

export async function getJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 8000
): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  return parseResponse(res);
}

export async function persistCreds<T>(
  file: string,
  update: (cur: T) => T,
  backupSuffix = ".qc-bak"
): Promise<boolean> {
  const cur = await readJsonFile<T>(file);
  const next = update(cur);
  const bak = file + backupSuffix;
  let first = false;
  try {
    await fs.access(bak);
  } catch {
    await fs.copyFile(file, bak);
    first = true;
  }
  const tmp = file + ".qc-tmp";
  await fs.writeFile(tmp, JSON.stringify(next, null, 2));
  await fs.rename(tmp, file);
  return first;
}
