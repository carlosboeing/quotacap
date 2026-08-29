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

async function acquireLock(lockPath: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fh = await fs.open(lockPath, "wx");
      await fh.close();
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > 5000) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch {
        /* lock vanished between open and stat — retry */
      }
      if (Date.now() > deadline) throw new Error(`persistCreds: lock busy: ${lockPath}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

export async function persistCreds<T>(
  file: string,
  update: (cur: T) => T,
  backupSuffix = ".qc-bak"
): Promise<boolean> {
  const lock = file + ".qc-lock";
  await acquireLock(lock);
  try {
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
    const st = await fs.stat(file);
    const tmp = `${file}.qc-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: st.mode & 0o777 });
    await fs.rename(tmp, file);
    return first;
  } finally {
    await fs.rm(lock, { force: true });
  }
}
