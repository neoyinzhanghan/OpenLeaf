import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-merge-"));
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;

const { loadConfig } = await import("../config.js");
loadConfig(true);

const { ensureProjectGit } = await import("./projectGit.js");
const {
  startBranchMerge,
  getBranchMerge,
  resolveMergeConflict,
  completeBranchMerge,
  abortBranchMerge,
  assertNoActiveMerge,
} = await import("./branchMerge.js");
const { intentionalCommit, forkBranch, loadTimeline, checkoutTimeline } = await import("./timeline.js");

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (e) {
    const ex = e as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof ex.code === "number" ? ex.code : 1,
      stdout: String(ex.stdout ?? ""),
      stderr: String(ex.stderr ?? ""),
    };
  }
}

async function seedProject(id: string): Promise<void> {
  const dir = path.join(projectsRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "main.tex"), "base\n", "utf8");
  await ensureProjectGit(id);
  await intentionalCommit(id, { branchId: "main", message: "base" });
}

describe("branchMerge", () => {
  before(() => {
    loadConfig(true);
  });

  after(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("resolves content conflicts then completes a merge commit", async () => {
    const id = "merge-conflict";
    await seedProject(id);
    const tl = await loadTimeline(id);
    const mainHead = tl.branches.find((b) => b.id === "main")!.headNodeId!;
    const forked = await forkBranch(id, { fromNodeId: mainHead, name: "feature" });
    const featureId = forked.branch.id;

    // Edit feature tip
    await checkoutTimeline(id, { branchId: featureId, nodeId: null });
    const featureRoot = path.join(projectsRoot, id, ".openleaf", "worktrees", featureId);
    fs.writeFileSync(path.join(featureRoot, "main.tex"), "theirs\n", "utf8");
    await intentionalCommit(id, { branchId: featureId, message: "feature edit" });

    // Edit main tip (diverges)
    await checkoutTimeline(id, { branchId: "main", nodeId: null });
    fs.writeFileSync(path.join(projectsRoot, id, "main.tex"), "ours\n", "utf8");
    await intentionalCommit(id, { branchId: "main", message: "main edit" });

    const session = await startBranchMerge(id, { sourceBranchId: featureId, targetBranchId: "main" });
    assert.equal(session.status, "in_progress");
    assert.ok(session.conflicts.some((c) => c.path === "main.tex"));

    await assert.rejects(() => assertNoActiveMerge(id), /merge is in progress/i);

    const afterOurs = await resolveMergeConflict(id, { path: "main.tex", strategy: "ours" });
    assert.equal(afterOurs.conflicts.find((c) => c.path === "main.tex")?.resolved, true);
    assert.equal(afterOurs.status, "ready");

    const done = await completeBranchMerge(id, { message: "Merge feature into main" });
    assert.equal(done.session.status, "completed");
    assert.match(fs.readFileSync(path.join(projectsRoot, id, "main.tex"), "utf8"), /ours/);
    assert.equal(await getBranchMerge(id), null);

    const parents = await git(path.join(projectsRoot, id), ["rev-list", "--parents", "-n", "1", "HEAD"]);
    assert.equal(parents.stdout.trim().split(/\s+/).length, 3); // hash + 2 parents
  });

  it("completes a clean merge with no conflicts", async () => {
    const id = "merge-clean";
    await seedProject(id);
    const tl = await loadTimeline(id);
    const mainHead = tl.branches.find((b) => b.id === "main")!.headNodeId!;
    const forked = await forkBranch(id, { fromNodeId: mainHead, name: "clean-feat" });
    const featureId = forked.branch.id;

    await checkoutTimeline(id, { branchId: featureId, nodeId: null });
    const featureRoot = path.join(projectsRoot, id, ".openleaf", "worktrees", featureId);
    fs.writeFileSync(path.join(featureRoot, "extra.tex"), "only on feature\n", "utf8");
    await intentionalCommit(id, { branchId: featureId, message: "add extra" });

    await checkoutTimeline(id, { branchId: "main", nodeId: null });
    const session = await startBranchMerge(id, { sourceBranchId: featureId, targetBranchId: "main" });
    assert.equal(session.status, "ready");
    assert.equal(session.conflicts.length, 0);

    const done = await completeBranchMerge(id);
    assert.equal(done.session.status, "completed");
    assert.ok(fs.existsSync(path.join(projectsRoot, id, "extra.tex")));
    const after = await loadTimeline(id);
    const mergeNode = after.nodes.find((n) => n.id === done.nodeId);
    assert.ok(mergeNode);
    assert.ok(mergeNode!.mergeParentId, "merge leaf should record the source tip");
    const sourceTip = after.branches.find((b) => b.id === featureId)?.headNodeId;
    assert.equal(mergeNode!.mergeParentId, sourceTip);
  });

  it("aborts a conflicted merge and restores the target tip", async () => {
    const id = "merge-abort";
    await seedProject(id);
    const tl = await loadTimeline(id);
    const mainHead = tl.branches.find((b) => b.id === "main")!.headNodeId!;
    const forked = await forkBranch(id, { fromNodeId: mainHead, name: "abort-feat" });
    const featureId = forked.branch.id;

    await checkoutTimeline(id, { branchId: featureId, nodeId: null });
    const featureRoot = path.join(projectsRoot, id, ".openleaf", "worktrees", featureId);
    fs.writeFileSync(path.join(featureRoot, "main.tex"), "theirs\n", "utf8");
    await intentionalCommit(id, { branchId: featureId, message: "feature edit" });

    await checkoutTimeline(id, { branchId: "main", nodeId: null });
    fs.writeFileSync(path.join(projectsRoot, id, "main.tex"), "ours\n", "utf8");
    await intentionalCommit(id, { branchId: "main", message: "main edit" });
    const before = fs.readFileSync(path.join(projectsRoot, id, "main.tex"), "utf8");

    await startBranchMerge(id, { sourceBranchId: featureId, targetBranchId: "main" });
    await abortBranchMerge(id);
    assert.equal(await getBranchMerge(id), null);
    assert.equal(fs.readFileSync(path.join(projectsRoot, id, "main.tex"), "utf8"), before);
    const mergeHead = await git(path.join(projectsRoot, id), ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    assert.notEqual(mergeHead.code, 0);
  });

  it("clears an orphaned merge session when MERGE_HEAD is gone", async () => {
    const id = "merge-orphan";
    await seedProject(id);
    const tl = await loadTimeline(id);
    const mainHead = tl.branches.find((b) => b.id === "main")!.headNodeId!;
    const forked = await forkBranch(id, { fromNodeId: mainHead, name: "orphan-feat" });
    const featureId = forked.branch.id;

    await checkoutTimeline(id, { branchId: featureId, nodeId: null });
    const featureRoot = path.join(projectsRoot, id, ".openleaf", "worktrees", featureId);
    fs.writeFileSync(path.join(featureRoot, "main.tex"), "theirs\n", "utf8");
    await intentionalCommit(id, { branchId: featureId, message: "feature edit" });

    await checkoutTimeline(id, { branchId: "main", nodeId: null });
    fs.writeFileSync(path.join(projectsRoot, id, "main.tex"), "ours\n", "utf8");
    await intentionalCommit(id, { branchId: "main", message: "main edit" });

    await startBranchMerge(id, { sourceBranchId: featureId, targetBranchId: "main" });
    await git(path.join(projectsRoot, id), ["merge", "--abort"]);
    assert.equal(await getBranchMerge(id), null);
  });

  it("accepts delete/modify with use-incoming (rm)", async () => {
    const id = "merge-delete";
    await seedProject(id);
    const tl = await loadTimeline(id);
    const mainHead = tl.branches.find((b) => b.id === "main")!.headNodeId!;
    const forked = await forkBranch(id, { fromNodeId: mainHead, name: "del-feat" });
    const featureId = forked.branch.id;

    await checkoutTimeline(id, { branchId: featureId, nodeId: null });
    const featureRoot = path.join(projectsRoot, id, ".openleaf", "worktrees", featureId);
    fs.unlinkSync(path.join(featureRoot, "main.tex"));
    await intentionalCommit(id, { branchId: featureId, message: "delete main.tex" });

    await checkoutTimeline(id, { branchId: "main", nodeId: null });
    fs.writeFileSync(path.join(projectsRoot, id, "main.tex"), "kept on main\n", "utf8");
    await intentionalCommit(id, { branchId: "main", message: "edit main.tex" });

    const session = await startBranchMerge(id, { sourceBranchId: featureId, targetBranchId: "main" });
    const del = session.conflicts.find((c) => c.path === "main.tex");
    assert.ok(del);
    assert.equal(del!.kind, "deleted-by-them");

    await resolveMergeConflict(id, { path: "main.tex", strategy: "theirs" });
    const done = await completeBranchMerge(id);
    assert.equal(done.session.status, "completed");
    assert.equal(fs.existsSync(path.join(projectsRoot, id, "main.tex")), false);
  });
});
