import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-lookupcache-"));
process.env.OPENLEAF_LIBRARY_ROOT = libraryRoot;

const { loadConfig } = await import("../../../config.js");
loadConfig(true);

const { lookupCachePath, readLookupCache, writeLookupCache } = await import("./lookupCache.js");

describe("lookupCache", () => {
  after(() => {
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  });

  it("gives distinct keys distinct cache files even after sanitization collapses them", () => {
    // Regression: sanitizeKey() lowercases, collapses all non [a-z0-9._-]
    // characters to "_", and truncates to 180 chars, so two different keys
    // could normalize to the identical string and silently share (and
    // overwrite) one cache file. A hash of the original key keeps them apart.
    const a = lookupCachePath("doi", "10.1000/a!b");
    const b = lookupCachePath("doi", "10.1000/a?b");
    assert.notEqual(a, b);

    const long1 = `10.1000/${"x".repeat(200)}-one`;
    const long2 = `10.1000/${"x".repeat(200)}-two`;
    assert.notEqual(lookupCachePath("doi", long1), lookupCachePath("doi", long2));
  });

  it("round-trips a cached value under its own key without colliding with a similar key", async () => {
    await writeLookupCache("doi", "10.1000/a!b", { hit: "first" });
    await writeLookupCache("doi", "10.1000/a?b", { hit: "second" });

    const first = await readLookupCache<{ hit: string }>("doi", "10.1000/a!b");
    const second = await readLookupCache<{ hit: string }>("doi", "10.1000/a?b");
    assert.equal(first?.hit, "first");
    assert.equal(second?.hit, "second");
  });
});
