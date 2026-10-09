import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { compileRootForTree, sourceHasDocumentClass } from "./compileRoot.ts";

describe("sourceHasDocumentClass", () => {
  it("ignores a commented-out documentclass", () => {
    assert.equal(sourceHasDocumentClass("% \\documentclass{article}\n\\input{sections/body}\n"), false);
    assert.equal(sourceHasDocumentClass("\\documentclass[11pt]{article}\n"), true);
  });
});

describe("compileRootForTree", () => {
  it("uses a root-level document and leaves fragments on the saved main", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-root-"));
    fs.writeFileSync(path.join(cwd, "supplementary.tex"), "\\documentclass{article}\n\\begin{document}S\\end{document}\n");
    fs.writeFileSync(path.join(cwd, "metrics.tex"), "\\newcommand{\\x}{1}\n");
    assert.equal(compileRootForTree(cwd, "supplementary.tex", "main.tex"), "supplementary.tex");
    assert.equal(compileRootForTree(cwd, "metrics.tex", "main.tex"), "main.tex");
    assert.equal(compileRootForTree(cwd, undefined, "main.tex"), "main.tex");
    assert.throws(() => compileRootForTree(cwd, "sections/body.tex", "main.tex"), /project root/);
    assert.throws(() => compileRootForTree(cwd, "../secret.tex", "main.tex"), /project root/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
