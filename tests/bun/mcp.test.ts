import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTool } from "../../src/mcp/server.ts";

test("service-down with no stored readings reports service-unavailable", async () => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop();
  process.env.QUOTACAP_HOME = mkdtempSync(join(tmpdir(), "qc-bun-mcp-"));
  process.env.QUOTACAP_URL = `http://127.0.0.1:${port}`;
  try {
    await expect(handleTool("get_quotas", {})).rejects.toThrow(/service-unavailable/);
  } finally {
    delete process.env.QUOTACAP_URL;
    delete process.env.QUOTACAP_HOME;
  }
});
