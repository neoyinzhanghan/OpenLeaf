import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-mainfile-"));
process.env.OPENLEAF_PROJECTS_ROOT = sandbox;

const { createProject, readProjectConfig, setProjectMainFile } = await import("./projectFs.js");

describe("setProjectMainFile", () => {
  before(async () => {
    await createProject("paper", "missing-template");
    fs.writeFileSync(path.join(sandbox, "paper", "alt.tex"), "\\documentclass{article}\\begin{document}Hi\\end{document}\n");
  });

  after(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("switches the main document to another .tex file", async () => {
    const cfg = await setProjectMainFile("paper", "alt.tex");
    assert.equal(cfg.mainFile, "alt.tex");
    const disk = await readProjectConfig("paper");
    assert.equal(disk.mainFile, "alt.tex");
  });

  it("rejects non-tex paths", async () => {
    await assert.rejects(() => setProjectMainFile("paper", "openleaf.json"), /Main document must be a \.tex file/);
  });

  it("rejects missing files", async () => {
    await assert.rejects(() => setProjectMainFile("paper", "missing.tex"), /File not found/);
  });
});
