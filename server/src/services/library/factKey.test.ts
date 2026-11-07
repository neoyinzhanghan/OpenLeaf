import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidFactKey, slugifyFactKey, uniquifyFactKey } from "./factKey.js";

describe("fact keys", () => {
  it("accepts valid keys and rejects bad ones", () => {
    assert.equal(isValidFactKey("auroc-tcga"), true);
    assert.equal(isValidFactKey("a"), false);
    assert.equal(isValidFactKey("1bad"), false);
    assert.equal(isValidFactKey("HasCaps"), false);
    assert.equal(isValidFactKey("has_underscore"), false);
  });

  it("slugifies titles into valid keys", () => {
    assert.equal(slugifyFactKey("AUROC of ResGAT on TCGA-NSCLC"), "auroc-of-resgat-on-tcga-nsclc");
    assert.ok(isValidFactKey(slugifyFactKey("123 start with digits")));
    assert.ok(isValidFactKey(slugifyFactKey("!!!")));
  });

  it("uniquifies collisions with -2, -3…", () => {
    const taken = new Set(["fee-per-read", "fee-per-read-2"]);
    assert.equal(uniquifyFactKey(undefined, "Fee per read", taken), "fee-per-read-3");
    assert.equal(uniquifyFactKey("custom-key", "ignored", new Set()), "custom-key");
    assert.equal(uniquifyFactKey("bad Key!", "Fee per read", new Set(["fee-per-read"])), "fee-per-read-2");
  });
});
