import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-prune-"));
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;

const { loadConfig } = await import("../config.js");
loadConfig(true);

const { ensureProjectGit } = await import("./projectGit.js");
const {
  intentionalCommit,
  forkBranch,
  loadTimeline,
  getTimelineView,
  pruneBranchTip,
  checkoutTimeline,
  getBranch,
} = await import("./timeline.js");

async function seedProject(id: string): Promise<void> {
  const dir = path.join(projectsRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "main.tex"), "base\n", "utf8");
  await ensureProjectGit(id);
  await intentionalCommit(id, { branchId: "main", message: "base" });
}

describe("pruneBranchTip", () => {
  const id = "prune-demo";

  before(async () => {
    await seedProject(id);
  });

  after(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("refuses to prune sacred main", async () => {
    await assert.rejects(() => pruneBranchTip(id, "main"), /sacred|main/i);
  });

  it("hides a tip, restores it, and can delete forever from trash", async () => {
    const {
      listPrunedTips,
      unpruneBranchTip,
      deletePrunedBranchForever,
      ensureBranchRoot,
    } = await import("./timeline.js");

    const tl = await loadTimeline(id);
    const main = getBranch(tl, "main");
    const forked = await forkBranch(id, {
      fromNodeId: main.headNodeId!,
      name: "feature-prune-me",
      activate: true,
    });
    assert.equal((await loadTimeline(id)).activeBranchId, forked.branch.id);

    const view = await pruneBranchTip(id, forked.branch.id);
    assert.equal(view.activeBranchId, "main");
    assert.ok(!view.branches.some((b) => b.id === forked.branch.id));

    // Soft-pruned tips cannot be opened / written via ensureBranchRoot
    await assert.rejects(() => ensureBranchRoot(id, forked.branch.id), /pruned/i);

    const trash = await listPrunedTips(id);
    assert.ok(trash.some((t) => t.branchId === forked.branch.id));

    const restored = await unpruneBranchTip(id, forked.branch.id);
    assert.ok(restored.branches.some((b) => b.id === forked.branch.id));
    assert.equal((await listPrunedTips(id)).length, 0);

    await pruneBranchTip(id, forked.branch.id);
    await assert.rejects(
      () => deletePrunedBranchForever(id, "main"),
      /sacred|main/i,
    );
    // Must prune first — live tip cannot be deleted forever
    const live = await forkBranch(id, {
      fromNodeId: main.headNodeId!,
      name: "live-no-delete",
      activate: false,
    });
    await assert.rejects(() => deletePrunedBranchForever(id, live.branch.id), /trash|prune/i);

    const gone = await deletePrunedBranchForever(id, forked.branch.id);
    assert.equal(gone.deleted.name, "feature-prune-me");
    assert.ok(!gone.timeline.branches.some((b) => b.id === forked.branch.id));
    const raw = await loadTimeline(id);
    assert.ok(!raw.branches.some((b) => b.id === forked.branch.id));
    assert.ok(!raw.nodes.some((n) => n.branchId === forked.branch.id));
  });

  it("refuses prune while a collab room still has connected editors", async () => {
    const { assertTipSafeForDestructiveOp } = await import("./timeline.js");
    const roomMod = await import("./collab/room.js");

    const tl = await loadTimeline(id);
    const main = getBranch(tl, "main");
    const forked = await forkBranch(id, {
      fromNodeId: main.headNodeId!,
      name: "busy-editors",
      activate: false,
    });

    const room = await roomMod.getOrCreateRoom(id, forked.branch.id);
    const client = { id: "test-editor" };
    room.addClient(client);
    try {
      await assert.rejects(
        () => assertTipSafeForDestructiveOp(id, forked.branch.id, "prune"),
        /editor|connected/i,
      );
      await assert.rejects(() => pruneBranchTip(id, forked.branch.id), /editor|connected/i);

      // Host nuclear option: kick editors and prune anyway
      const forced = await pruneBranchTip(id, forked.branch.id, { forceKickEditors: true });
      assert.ok(!forced.branches.some((b) => b.id === forked.branch.id));
      assert.equal(room.clientCount, 0);
    } finally {
      try {
        room.removeClient(client);
      } catch {
        /* already kicked */
      }
      await roomMod.releaseRoomIfEmpty(id, forked.branch.id);
    }
  });

  it("refuses delete forever when the worktree still has uncommitted edits", async () => {
    const { deletePrunedBranchForever, unpruneBranchTip } = await import("./timeline.js");
    const fs = await import("node:fs");
    const path = await import("node:path");

    const tl = await loadTimeline(id);
    const main = getBranch(tl, "main");
    const forked = await forkBranch(id, {
      fromNodeId: main.headNodeId!,
      name: "dirty-delete-me",
      activate: true,
    });
    const { ensureBranchRoot } = await import("./timeline.js");
    const wt = await ensureBranchRoot(id, forked.branch.id);
    fs.writeFileSync(path.join(wt, "dirty-extra.tex"), "unsaved\n", "utf8");

    await pruneBranchTip(id, forked.branch.id);
    await assert.rejects(
      () => deletePrunedBranchForever(id, forked.branch.id),
      /uncommitted|dirty|edits/i,
    );

    // Typed-name confirmation path: discard dirty and delete
    const gone = await deletePrunedBranchForever(id, forked.branch.id, { discardDirty: true });
    assert.equal(gone.deleted.name, "dirty-delete-me");
    void unpruneBranchTip;
  });
});