import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-fork-live-"));
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;

const { loadConfig } = await import("../config.js");
loadConfig(true);

const { ensureProjectGit } = await import("./projectGit.js");
const { intentionalCommit, forkBranch, loadTimeline, getBranch, ensureBranchRoot } = await import(
  "./timeline.js"
);

describe("forkBranch live working copy", () => {
  const id = "wsip";

  after(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("copies uncommitted manuscript files onto a fork of the live tip", async () => {
    const dir = path.join(projectsRoot, id);
    fs.mkdirSync(path.join(dir, "sections"), { recursive: true });
    fs.writeFileSync(path.join(dir, "main.tex"), "OpenLeaf Example Article\n", "utf8");
    fs.writeFileSync(path.join(dir, "sections", "old.tex"), "template section\n", "utf8");
    await ensureProjectGit(id);
    await intentionalCommit(id, { branchId: "main", message: "example snapshot" });

    const exampleNodeId = getBranch(await loadTimeline(id), "main").headNodeId;
    assert.ok(exampleNodeId);

    fs.writeFileSync(path.join(dir, "main.tex"), "second commit\n", "utf8");
    await intentionalCommit(id, { branchId: "main", message: "second" });

    fs.writeFileSync(path.join(dir, "main.tex"), "WSIP live draft\n", "utf8");
    fs.writeFileSync(path.join(dir, "sections", "new.tex"), "untracked section\n", "utf8");
    fs.rmSync(path.join(dir, "sections", "old.tex"));

    const head = getBranch(await loadTimeline(id), "main").headNodeId!;
    const live = await forkBranch(id, { fromNodeId: head, name: "ayesha", activate: false });
    const liveRoot = await ensureBranchRoot(id, live.branch.id);
    assert.equal(fs.readFileSync(path.join(liveRoot, "main.tex"), "utf8"), "WSIP live draft\n");
    assert.equal(fs.readFileSync(path.join(liveRoot, "sections", "new.tex"), "utf8"), "untracked section\n");
    assert.equal(fs.existsSync(path.join(liveRoot, "sections", "old.tex")), false);
    assert.equal(fs.existsSync(path.join(liveRoot, ".git")), true);
    assert.equal(fs.existsSync(path.join(liveRoot, ".openleaf")), false);
    const { execFileSync } = await import("node:child_process");
    const leafTip = execFileSync("git", ["show", "HEAD:main.tex"], { cwd: liveRoot, encoding: "utf8" });
    assert.equal(leafTip, "WSIP live draft\n");
    assert.equal(fs.readFileSync(path.join(dir, "main.tex"), "utf8"), "WSIP live draft\n");
    const mainTip = execFileSync("git", ["show", "main:main.tex"], { cwd: dir, encoding: "utf8" });
    assert.equal(mainTip, "second commit\n");

    const historical = await forkBranch(id, {
      fromNodeId: exampleNodeId!,
      name: "old-checkpoint",
      activate: false,
    });
    const oldRoot = await ensureBranchRoot(id, historical.branch.id);
    assert.equal(fs.readFileSync(path.join(oldRoot, "main.tex"), "utf8"), "OpenLeaf Example Article\n");
    assert.equal(fs.readFileSync(path.join(oldRoot, "sections", "old.tex"), "utf8"), "template section\n");
    assert.equal(fs.existsSync(path.join(oldRoot, "sections", "new.tex")), false);
  });
});
