import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nodeMajor } from "./deps.js";

describe("Node runtime compatibility", () => {
  it("requires SQLite support without an experimental flag", () => {
    const original = Object.getOwnPropertyDescriptor(process.versions, "node")!;
    try {
      for (const [version, supported] of [
        ["20.20.2", false],
        ["22.12.0", false],
        ["22.13.0", true],
        ["23.3.0", false],
        ["23.4.0", true],
        ["24.0.0", true],
      ] as const) {
        Object.defineProperty(process.versions, "node", { ...original, value: version });
        assert.equal(nodeMajor(), supported, version);
      }
    } finally {
      Object.defineProperty(process.versions, "node", original);
    }
  });
});
