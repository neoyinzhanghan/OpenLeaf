import assert from "node:assert/strict";
import test from "node:test";
import { nextCompileRoot, rootLevelTexCandidate } from "./standaloneRoot.ts";

test("a root-level tex other than the saved main is the compile request", () => {
  assert.equal(rootLevelTexCandidate("supplementary.tex", "main.tex"), "supplementary.tex");
  assert.equal(rootLevelTexCandidate("main.tex", "main.tex"), null);
  assert.equal(rootLevelTexCandidate("sections/supplementary_information.tex", "main.tex"), null);
  const next = nextCompileRoot({
    activePath: "supplementary.tex",
    savedMain: "main.tex",
    heldRoot: null,
  });
  assert.deepEqual(next, { compileRoot: "supplementary.tex", heldRoot: "supplementary.tex" });
});

test("SyncTeX into an included file keeps the side document", () => {
  const next = nextCompileRoot({
    activePath: "sections/supplementary_information.tex",
    savedMain: "main.tex",
    heldRoot: "supplementary.tex",
  });
  assert.deepEqual(next, { compileRoot: "supplementary.tex", heldRoot: "supplementary.tex" });
});

test("opening the saved main drops the side document", () => {
  const next = nextCompileRoot({
    activePath: "main.tex",
    savedMain: "main.tex",
    heldRoot: "supplementary.tex",
  });
  assert.deepEqual(next, { compileRoot: null, heldRoot: null });
});
