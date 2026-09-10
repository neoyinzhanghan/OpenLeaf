import { flushProjectRoom } from "./collab/room.js";
import { isGitEnabled, listWorkingTreeChanges } from "./projectGit.js";
import { ensureBranchRoot, isBranchPruned, loadTimeline } from "./timeline.js";

export type BranchLeafStat = {
  branchId: string;
  name: string;
  sacred: boolean;
  headNodeId: string | null;
  tipHash: string | null;
  dirty: boolean;
  additions: number;
  deletions: number;
  files: number;
};

/**
 * Live working-copy +/- for every timeline branch (uncommitted leaf vs tip commit).
 * Share-link clients use this to watch other branches without checking them out.
 */
export async function listBranchLeafStats(projectId: string): Promise<BranchLeafStat[]> {
  const state = await loadTimeline(projectId);
  const out: BranchLeafStat[] = [];

  for (const branch of state.branches) {
    if (isBranchPruned(branch)) continue;
    const head = branch.headNodeId
      ? state.nodes.find((n) => n.id === branch.headNodeId) ?? null
      : null;
    const tipHash = head?.gitHash ?? null;

    try {
      await flushProjectRoom(projectId, { commit: false, branchId: branch.id });
    } catch {
      /* room may not exist */
    }

    let additions = 0;
    let deletions = 0;
    let files = 0;
    let dirty = false;

    if (isGitEnabled() && tipHash) {
      try {
        const cwd = await ensureBranchRoot(projectId, branch.id);
        const tree = await listWorkingTreeChanges(projectId, tipHash, { cwd });
        additions = tree.additions;
        deletions = tree.deletions;
        files = tree.files.length;
        dirty = files > 0;
      } catch {
        dirty = false;
      }
    } else if (isGitEnabled()) {
      try {
        const cwd = await ensureBranchRoot(projectId, branch.id);
        // No tip yet — treat any tracked/untracked source as dirty via empty-tree? skip.
        void cwd;
      } catch {
        /* ignore */
      }
    }

    out.push({
      branchId: branch.id,
      name: branch.name,
      sacred: Boolean(branch.sacred),
      headNodeId: branch.headNodeId,
      tipHash,
      dirty,
      additions,
      deletions,
      files,
    });
  }

  return out;
}
