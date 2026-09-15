import { describe, it, expect } from "vitest";
import { compareVersions, parseVersion } from "../../src/runtime/versions.js";

describe("versions", () => {
  describe("parseVersion", () => {
    it("parses dotted numeric versions with leading-v tolerance", () => {
      expect(parseVersion("0.0.22")).toEqual([0, 0, 22]);
      expect(parseVersion("v1.2")).toEqual([1, 2]);
      expect(parseVersion("1.0.0.4")).toEqual([1, 0, 0, 4]);
    });

    it("parses versions with git commit SHA suffixes", () => {
      expect(parseVersion("0.0.32-6ffb4f9")).toEqual([0, 0, 32]);
      expect(parseVersion("v0.0.32-6ffb4f9")).toEqual([0, 0, 32]);
      expect(parseVersion("0.0.32-6ffb4f9-dirty")).toEqual([0, 0, 32]);
      expect(parseVersion("0.0.32-3050b3f")).toEqual([0, 0, 32]);
    });

    it("returns null for non-numeric or malformed strings", () => {
      expect(parseVersion("test")).toBeNull();
      expect(parseVersion("0.0.0-stale")).toBeNull();
      expect(parseVersion("")).toBeNull();
      expect(parseVersion("abc-123")).toBeNull();
    });
  });

  describe("compareVersions", () => {
    it("compares basic numeric versions", () => {
      expect(compareVersions("0.0.22", "0.0.22")).toBe(0);
      expect(compareVersions("v0.0.22", "0.0.22")).toBe(0);
      expect(compareVersions("0.0.23", "0.0.22")).toBe(1);
      expect(compareVersions("0.0.22", "0.0.23")).toBe(-1);
      expect(compareVersions("0.1.0", "0.0.99")).toBe(1);
      expect(compareVersions("1.0", "1.0.0")).toBe(0);
    });

    it("treats local commit build as ahead of its base release", () => {
      // 0.0.32-6ffb4f9 represents unreleased work on top of 0.0.32
      expect(compareVersions("0.0.32-6ffb4f9", "0.0.32")).toBe(1);
      expect(compareVersions("0.0.32", "0.0.32-6ffb4f9")).toBe(-1);
      expect(compareVersions("0.0.32-6ffb4f9", "0.0.32-6ffb4f9")).toBe(0);
    });

    it("compares local commit build correctly against different major/minor/patch releases", () => {
      // A new official release (0.0.33) is strictly newer than a local 0.0.32 build
      expect(compareVersions("0.0.33", "0.0.32-6ffb4f9")).toBe(1);
      expect(compareVersions("0.0.32-6ffb4f9", "0.0.33")).toBe(-1);

      // An older release (0.0.31) is strictly older than a local 0.0.32 build
      expect(compareVersions("0.0.31", "0.0.32-6ffb4f9")).toBe(-1);
      expect(compareVersions("0.0.32-6ffb4f9", "0.0.31")).toBe(1);
    });

    it("falls back to string order when unparseable", () => {
      expect(compareVersions("test", "test")).toBe(0);
      expect(compareVersions("0.0.0-stale", "0.0.0-stale")).toBe(0);
      expect(compareVersions("b", "a")).toBe(1);
      expect(compareVersions("0.0.22", "test")).toBe(-1);
    });
  });
});
