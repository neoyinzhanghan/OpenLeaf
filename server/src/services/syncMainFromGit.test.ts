import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

const execFileAsync = promisify(execFile);

const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-sync-git-"));
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;

const { loadConfig } = await import("../config.js");
loadConfig(true);

const { ensureProjectGit } = await import("./projectGit.js");
const { forkBranch, getBranch, loadTimeline } = await import("./timeline.js");

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

async function seedRawGitProject(id: string): Promise<{ hashes: string[]; dir: string }> {
  const dir = path.join(projectsRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "main.tex"), "v1\n", "utf8");
  await ensureProjectGit(id);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "first", "--no-gpg-sign"]);
  const h1 = await git(dir, ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(dir, "main.tex"), "v2\n", "utf8");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "second", "--no-gpg-sign"]);
  const h2 = await git(dir, ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(dir, "main.tex"), "v3\n", "utf8");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "third", "--no-gpg-sign"]);
  const h3 = await git(dir, ["rev-parse", "HEAD"]);

  return { hashes: [h1, h2, h3], dir };
}

describe("syncMainFromGit", () => {
  const id = "sync-demo";
  let hashes: string[] = [];

  before(async () => {
    const seeded = await seedRawGitProject(id);
    hashes = seeded.hashes;

    // Stale timeline: only the first commit, head stuck in the past.
    const openleaf = path.join(seeded.dir, ".openleaf");
    fs.mkdirSync(openleaf, { recursive: true });
    fs.writeFileSync(
      path.join(openleaf, "timeline.json"),
      JSON.stringify(
        {
          version: 1,
          activeBranchId: "main",
          viewingNodeId: null,
          branches: [
            {
              id: "main",
              name: "main",
              sacred: true,
              headNodeId: "legacy-stale",
              createdAt: new Date().toISOString(),
              gitRef: "main",
            },
          ],
          nodes: [
            {
              id: "legacy-stale",
              branchId: "main",
              parentId: null,
              gitHash: hashes[0],
              message: "first",
              author: "Test",
              createdAt: new Date().toISOString(),
              legacy: true,
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  });

  after(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("rebuilds main chain from git and advances head", async () => {
    const tl = await loadTimeline(id);
    const mainNodes = tl.nodes.filter((n) => n.branchId === "main");
    assert.equal(mainNodes.length, 3);
    assert.deepEqual(
      mainNodes.map((n) => n.gitHash),
      hashes,
    );
    assert.equal(mainNodes[0]!.parentId, null);
    assert.equal(mainNodes[1]!.parentId, mainNodes[0]!.id);
    assert.equal(mainNodes[2]!.parentId, mainNodes[1]!.id);
    assert.equal(getBranch(tl, "main").headNodeId, mainNodes[2]!.id);
    // First hash keeps the pre-existing node id
    assert.equal(mainNodes[0]!.id, "legacy-stale");
    assert.equal(mainNodes[0]!.message, "first");
    assert.equal(mainNodes[2]!.message, "third");
  });

  it("second load is stable (same ids / head)", async () => {
    const a = await loadTimeline(id);
    const b = await loadTimeline(id);
    assert.deepEqual(
      a.nodes.filter((n) => n.branchId === "main").map((n) => n.id),
      b.nodes.filter((n) => n.branchId === "main").map((n) => n.id),
    );
    assert.equal(getBranch(a, "main").headNodeId, getBranch(b, "main").headNodeId);
  });

  it("preserves OpenLeaf fork nodes across sync", async () => {
    const tl = await loadTimeline(id);
    const main = getBranch(tl, "main");
    const forked = await forkBranch(id, {
      fromNodeId: main.headNodeId!,
      name: "side-feature",
      activate: false,
    });

    // External commit on main after the fork
    const dir = path.join(projectsRoot, id);
    fs.writeFileSync(path.join(dir, "main.tex"), "v4\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "fourth", "--no-gpg-sign"]);
    const h4 = await git(dir, ["rev-parse", "HEAD"]);

    const after = await loadTimeline(id);
    assert.ok(after.branches.some((b) => b.id === forked.branch.id));
    assert.ok(after.nodes.some((n) => n.branchId === forked.branch.id));
    const mainNodes = after.nodes.filter((n) => n.branchId === "main");
    assert.equal(mainNodes.length, 4);
    assert.equal(mainNodes[3]!.gitHash, h4);
    assert.equal(getBranch(after, "main").headNodeId, mainNodes[3]!.id);
  });

  describe("imported local git branches", () => {
  const id = "sync-git-feature";
  let dir = "";
  let mainTip = "";
  let featureHashes: string[] = [];

  before(async () => {
    dir = path.join(projectsRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "main.tex"), "main-1\n", "utf8");
    await ensureProjectGit(id);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "on-main", "--no-gpg-sign"]);
    mainTip = await git(dir, ["rev-parse", "HEAD"]);

    await git(dir, ["checkout", "-b", "fair-viewport-benchmark"]);
    fs.writeFileSync(path.join(dir, "main.tex"), "feat-1\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "feature one", "--no-gpg-sign"]);
    const f1 = await git(dir, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(dir, "main.tex"), "feat-2\n", "utf8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "feature two", "--no-gpg-sign"]);
    const f2 = await git(dir, ["rev-parse", "HEAD"]);
    featureHashes = [f1, f2];
  });

  it("imports a local non-main git branch as an explore thread", async () => {
    const tl = await loadTimeline(id);
    const imported = tl.branches.find((b) => b.importedGit || b.gitRef === "fair-viewport-benchmark");
    assert.ok(imported, "expected imported git branch on the timeline");
    assert.equal(imported!.name, "fair-viewport-benchmark");
    assert.equal(imported!.gitRef, "fair-viewport-benchmark");
    assert.equal(imported!.sacred, false);

    const nodes = tl.nodes.filter((n) => n.branchId === imported!.id);
    assert.equal(nodes.length, 2);
    assert.deepEqual(
      nodes.map((n) => n.gitHash),
      featureHashes,
    );
    const mainHead = tl.nodes.find((n) => n.gitHash === mainTip && n.branchId === "main");
    assert.ok(mainHead);
    assert.equal(nodes[0]!.parentId, mainHead!.id);
    assert.equal(nodes[1]!.parentId, nodes[0]!.id);
    assert.equal(imported!.headNodeId, nodes[1]!.id);
  });

  it("second load keeps imported node ids stable", async () => {
    const a = await loadTimeline(id);
    const b = await loadTimeline(id);
    const aImp = a.branches.find((x) => x.gitRef === "fair-viewport-benchmark")!;
    const bImp = b.branches.find((x) => x.gitRef === "fair-viewport-benchmark")!;
    assert.equal(aImp.id, bImp.id);
    assert.deepEqual(
      a.nodes.filter((n) => n.branchId === aImp.id).map((n) => n.id),
      b.nodes.filter((n) => n.branchId === bImp.id).map((n) => n.id),
    );
  });

  it("does not import OpenLeaf ol/ forks as git-* threads", async () => {
    const tl = await loadTimeline(id);
    const main = getBranch(tl, "main");
    const forked = await forkBranch(id, {
      fromNodeId: main.headNodeId!,
      name: "methods-rewrite",
      activate: false,
    });
    const after = await loadTimeline(id);
    assert.ok(after.branches.some((b) => b.id === forked.branch.id));
    assert.equal(forked.branch.gitRef.startsWith("ol/"), true);
    assert.ok(!after.branches.some((b) => b.id === `git-${forked.branch.gitRef}`));
    assert.ok(!after.branches.some((b) => b.importedGit && b.gitRef === forked.branch.gitRef));
  });

  it("keeps an imported thread after it is merged into main", async () => {
    await git(dir, ["checkout", "main"]);
    await git(dir, ["merge", "fair-viewport-benchmark", "-m", "merge feature", "--no-gpg-sign", "--no-ff"]);
    const tl = await loadTimeline(id);
    const imported = tl.branches.find((b) => b.gitRef === "fair-viewport-benchmark");
    assert.ok(imported, "merged git branch should remain explorable");
    const nodes = tl.nodes.filter((n) => n.branchId === imported!.id);
    assert.ok(nodes.length >= 1);
    assert.equal(imported!.headNodeId, nodes[nodes.length - 1]!.id);
  });

  it("delete-forever of an imported thread does not delete the git branch", async () => {
    const { pruneBranchTip, deletePrunedBranchForever } = await import("./timeline.js");
    const tl = await loadTimeline(id);
    const imported = tl.branches.find((b) => b.gitRef === "fair-viewport-benchmark");
    assert.ok(imported);
    await pruneBranchTip(id, imported!.id);
    await deletePrunedBranchForever(id, imported!.id);
    const refs = await git(dir, ["show-ref", "--verify", "refs/heads/fair-viewport-benchmark"]);
    assert.match(refs, /fair-viewport-benchmark/);
  });
  });
});
