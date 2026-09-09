import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as Y from "yjs";
import { patchYText, prefixSuffixHunk, threeWayMerge } from "./textMerge.js";

describe("prefixSuffixHunk", () => {
  it("is a no-op for identical strings", () => {
    assert.deepEqual(prefixSuffixHunk("abc", "abc"), { start: 0, oldEnd: 0, inserted: "" });
  });

  it("replaces a middle span", () => {
    assert.deepEqual(prefixSuffixHunk("A\nB\nC\n", "A\nX\nC\n"), {
      start: 2,
      oldEnd: 3,
      inserted: "X",
    });
  });
});

describe("patchYText", () => {
  it("does not use a full delete+insert for a middle edit", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("t");
    ytext.insert(0, "hello world");
    patchYText(ytext, "hello there");
    assert.equal(ytext.toString(), "hello there");
  });
});

describe("threeWayMerge", () => {
  it("returns ours when both sides match", () => {
    assert.equal(threeWayMerge("a", "b", "b"), "b");
  });

  it("takes theirs when ours is unchanged", () => {
    assert.equal(threeWayMerge("base", "base", "theirs"), "theirs");
  });

  it("takes ours when theirs is unchanged", () => {
    assert.equal(threeWayMerge("base", "ours", "base"), "ours");
  });

  it("keeps non-overlapping line edits from both sides", () => {
    const base = "A\nB\nC\n";
    const ours = "A\nX\nC\n";
    const theirs = "A\nB\nY\n";
    assert.equal(threeWayMerge(base, ours, theirs), "A\nX\nY\n");
  });

  it("prefers theirs when hunks overlap", () => {
    const base = "A\nB\nC\n";
    const ours = "A\nX\nC\n";
    const theirs = "A\nY\nC\n";
    assert.equal(threeWayMerge(base, ours, theirs), "A\nY\nC\n");
  });
});
