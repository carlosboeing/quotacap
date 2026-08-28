import { test, expect } from "bun:test";
import { handleTool } from "../../src/mcp/server.ts";

test("translates daemon-down into guidance", async () => {
  process.env.QUOTACAP_URL = "http://127.0.0.1:59999";
  try {
    await expect(handleTool("get_quotas", {})).rejects.toThrow(/daemon not running/);
  } finally {
    delete process.env.QUOTACAP_URL;
  }
});