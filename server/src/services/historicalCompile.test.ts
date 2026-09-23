import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

const execFileAsync = promisify(execFile);

const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-hist-compile-"));
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;

const { loadConfig } = await import("../config.js");
loadConfig(true);

const { ensureProjectGit } = await import("./projectGit.js");
const { compileProject } = await import("./compiler.js");
const { ensureSnapshotRoot, snapshotRootIfPresent } = await import("./timeline.js");

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return String(stdout).trim();
}

describe("historical checkpoint compile", () => {
  const id = "hist-compile";
  let oldHash = "";
  let newHash = "";
  let dir = "";

  before(async () => {
    dir = path.join(projectsRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "main.tex"),
      "\\documentclass{article}\\begin{document}OLD\\end{document}\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "openleaf.json"),
      JSON.stringify({ mainFile: "main.tex", engine: "pdflatex" }),
      "utf8",
    );
    await ensureProjectGit(id);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "old", "--no-gpg-sign"]);
    oldHash = await git(dir, ["rev-parse", "HEAD"]);

    fs.writeFileSync(
      path.join(dir, "main.tex"),
      "\\documentclass{article}\\begin{document}NEW\\end{document}\n",
      "utf8",
    );
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "new", "--no-gpg-sign"]);
    newHash = await git(dir, ["rev-parse", "HEAD"]);
  });

  after(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("compiles a prior commit without changing the tip worktree", async () => {
    const tipBefore = fs.readFileSync(path.join(dir, "main.tex"), "utf8");
    assert.match(tipBefore, /NEW/);

    const result = await compileProject(id, undefined, { at: oldHash });
    assert.equal(result.ok, true, result.log.slice(-500));
    assert.ok(result.pdfRelative);

    const tipAfter = fs.readFileSync(path.join(dir, "main.tex"), "utf8");
    assert.equal(tipAfter, tipBefore);

    const snap = snapshotRootIfPresent(id, oldHash) ?? (await ensureSnapshotRoot(id, oldHash));
    const snapTex = fs.readFileSync(path.join(snap, "main.tex"), "utf8");
    assert.match(snapTex, /OLD/);
    assert.ok(fs.existsSync(path.join(snap, ".openleaf", "out", "main.pdf")));

    // Tip compile still uses the live tree
    const tip = await compileProject(id, undefined, { branchId: "main" });
    assert.equal(tip.ok, true, tip.log.slice(-500));
    assert.ok(fs.existsSync(path.join(dir, ".openleaf", "out", "main.pdf")));
    assert.notEqual(newHash, oldHash);
  });

  it("live tip compile picks up uncommitted working-tree edits", async () => {
    const committedPdf = fs.readFileSync(path.join(dir, ".openleaf", "out", "main.pdf"));
    fs.writeFileSync(
      path.join(dir, "main.tex"),
      "\\documentclass{article}\\begin{document}UNCOMMITTED_MARKER_QZ\\end{document}\n",
      "utf8",
    );
    const result = await compileProject(id, undefined, { branchId: "main" });
    assert.equal(result.ok, true, result.log.slice(-500));
    const livePdf = fs.readFileSync(path.join(dir, ".openleaf", "out", "main.pdf"));
    assert.notDeepEqual(livePdf, committedPdf);
    const headTex = await git(dir, ["show", "HEAD:main.tex"]);
    assert.match(headTex, /NEW/);
    assert.match(fs.readFileSync(path.join(dir, "main.tex"), "utf8"), /UNCOMMITTED_MARKER_QZ/);
  });
});
