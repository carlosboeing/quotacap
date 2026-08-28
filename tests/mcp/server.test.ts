import { describe, it, expect } from "vitest";
import { tools } from "../../src/mcp/server.js";
describe("mcp", () => {
  it("exposes three tools", () => {
    expect(tools.map(t=>t.name)).toEqual(expect.arrayContaining(["get_quotas","get_recommendation","forecast"]));
  });
});
