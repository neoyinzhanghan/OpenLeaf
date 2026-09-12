import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  autoCommitProject,
  ensureProjectGit,
  isGitEnabled,
  listProjectCommits,
  type GitAuthor,
} from "./projectGit.js";
import { projectDir, isTextPath, MAX_INLINE_FILE_BYTES, type TreeNode } from "./projectFs.js";

const execFileAsync = promisify(execFile);

export type TimelineNode = {
  id: string;
  branchId: string;
  parentId: string | null;
  /**
   * Second parent when this leaf is a merge commit — the tip that was
   * merged in. Used to draw a dotted merge arrow on the timeline.
   */
  mergeParentId?: string | null;
  gitHash: string;
  message: string;
  author: string;
  createdAt: string;
  /** Imported from pre-timeline auto-commits; display only. */
  legacy?: boolean;
};

export type TimelineBranch = {
  id: string;
  name: string;
  /** Sacred centerline (convention + UI emphasis). */
  sacred: boolean;
  headNodeId: string | null;
  createdAt: string;
  /** Git ref name (usually same as name for main). */
  gitRef: string;
  /**
   * Soft-prune: tip is hidden from the timeline and inaccessible, but data remains on disk.
   * ISO timestamp when pruned; null/undefined = live.
   */
  prunedAt?: string | null;
};

export type TimelineState = {
  version: 1;
  /** Host’s current branch (god-mode navigation). */
  activeBranchId: string;
  /**
   * When set to a non-head node id, editor is read-only snapshot view.
   * null = working on the branch tip (editable leaf).
   */
  viewingNodeId: string | null;
  branches: TimelineBranch[];
  nodes: TimelineNode[];
};

export type TimelineView = TimelineState & {
  dirty: boolean;
  canEdit: boolean;
  activeBranch: TimelineBranch;
  headNode: TimelineNode | null;
  viewingNode: TimelineNode | null;
  /** When set, editor should load files from this commit (read-only snapshot). */
  viewingGitHash: string | null;
};

function timelinePath(projectId: string): string {
  return path.join(projectDir(projectId), ".openleaf", "timeline.json");
}

function worktreePath(projectId: string, branchId: string): string {
  const safe = branchId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
  return path.join(projectDir(projectId), ".openleaf", "worktrees", safe);
}

function err(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

async function runGit(
  projectId: string,
  args: string[],
  opts?: { cwd?: string; allowFailure?: boolean; author?: GitAuthor },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cwd = opts?.cwd ?? projectDir(projectId);
  const name = opts?.author?.name?.trim() || "OpenLeaf";
  const email = opts?.author?.email?.trim() || "openleaf@local";
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
        GIT_TERMINAL_PROMPT: "0",
      },
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (e) {
    const ex = e as { stdout?: string; stderr?: string; code?: number; message?: string };
    if (opts?.allowFailure) {
      return {
        stdout: String(ex.stdout ?? ""),
        stderr: String(ex.stderr ?? ex.message ?? ""),
        code: typeof ex.code === "number" ? ex.code : 1,
      };
    }
    throw err(500, ex.stderr || ex.message || "git failed");
  }
}

async function saveTimeline(projectId: string, state: TimelineState): Promise<void> {
  const dest = timelinePath(projectId);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function emptyMain(): TimelineState {
  const now = new Date().toISOString();
  return {
    version: 1,
    activeBranchId: "main",
    viewingNodeId: null,
    branches: [
      {
        id: "main",
        name: "main",
        sacred: true,
        headNodeId: null,
        createdAt: now,
        gitRef: "main",
      },
    ],
    nodes: [],
  };
}

/** Max first-parent commits to ingest per branch per sync (next fetch continues). */
const GIT_CATCH_UP_LIMIT = 100;

/**
 * Fast-forward live timeline tips from git when an agent/CLI committed outside OpenLeaf.
 * Appends only: never rewrites, deletes, or rewinds. Skips a branch if its timeline head
 * is not an ancestor of the git tip (rebase / divergence).
 */
async function catchUpTimelineFromGit(projectId: string): Promise<boolean> {
  if (!isGitEnabled()) return false;
  const state = await loadTimeline(projectId);
  if (state.nodes.length === 0) return false;

  let dirty = false;
  const knownOnBranch = new Map<string, TimelineNode>();
  for (const n of state.nodes) {
    if (!n.gitHash) continue;
    knownOnBranch.set(`${n.branchId}:${n.gitHash}`, n);
  }

  for (const branch of state.branches) {
    if (isBranchPruned(branch)) continue;
    const head = branch.headNodeId
      ? state.nodes.find((n) => n.id === branch.headNodeId) ?? null
      : null;
    if (!head?.gitHash) continue;

    const tipHash = await resolveBranchGitTip(projectId, branch);
    if (!tipHash || tipHash === head.gitHash) continue;

    const ancestor = await runGit(
      projectId,
      ["merge-base", "--is-ancestor", head.gitHash, tipHash],
      { allowFailure: true },
    );
    if (ancestor.code !== 0) continue;

    const log = await runGit(
      projectId,
      [
        "log",
        "--first-parent",
        "--reverse",
        `-n${GIT_CATCH_UP_LIMIT}`,
        "--pretty=format:%H%x09%h%x09%an%x09%aI%x09%s",
        `${head.gitHash}..${tipHash}`,
      ],
      { allowFailure: true },
    );
    if (log.code !== 0 || !log.stdout.trim()) continue;

    let parentId = head.id;
    for (const line of log.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [hash, , author, date, ...rest] = trimmed.split("\t");
      if (!hash) continue;
      const existing = knownOnBranch.get(`${branch.id}:${hash}`);
      if (existing) {
        parentId = existing.id;
        continue;
      }
      const id = `n-${crypto.randomBytes(6).toString("hex")}`;
      const node: TimelineNode = {
        id,
        branchId: branch.id,
        parentId,
        gitHash: hash,
        message: rest.join("\t") || "(no message)",
        author: author || "unknown",
        createdAt: date || new Date().toISOString(),
      };
      state.nodes.push(node);
      knownOnBranch.set(`${branch.id}:${hash}`, node);
      parentId = id;
      dirty = true;
    }
    if (parentId !== head.id) {
      branch.headNodeId = parentId;
      dirty = true;
    }
  }

  if (dirty) await saveTimeline(projectId, state);
  return dirty;
}

async function resolveBranchGitTip(projectId: string, branch: TimelineBranch): Promise<string | null> {
  if (branch.gitRef) {
    const named = await runGit(
      projectId,
      ["rev-parse", "--verify", `refs/heads/${branch.gitRef}^{commit}`],
      { allowFailure: true },
    );
    if (named.code === 0 && named.stdout.trim()) return named.stdout.trim();
  }
  if (branch.id === "main" || branch.sacred) {
    const head = await runGit(projectId, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
    if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
  }
  return null;
}

async function syncTimelineFromGit(projectId: string): Promise<void> {
  await withTimelineLock(projectId, () => catchUpTimelineFromGit(projectId));
}

/** Import linear git history onto main as legacy nodes (once). */
async function migrateFromGit(projectId: string, state: TimelineState): Promise<TimelineState> {
  if (state.nodes.length > 0) return state;
  if (!isGitEnabled()) return state;

  await ensureProjectGit(projectId);
  const commits = await listProjectCommits(projectId, 200);
  if (commits.length === 0) return state;

  // listProjectCommits is newest-first; build oldest → newest chain
  const chrono = [...commits].reverse();
  let parentId: string | null = null;
  const nodes: TimelineNode[] = [];
  for (const c of chrono) {
    const id = `legacy-${c.shortHash}`;
    nodes.push({
      id,
      branchId: "main",
      parentId,
      gitHash: c.hash,
      message: c.message,
      author: c.author,
      createdAt: c.date,
      legacy: true,
    });
    parentId = id;
  }
  const main = state.branches.find((b) => b.id === "main")!;
  main.headNodeId = parentId;
  return { ...state, nodes, branches: state.branches.map((b) => (b.id === "main" ? main : b)) };
}

export async function loadTimeline(projectId: string): Promise<TimelineState> {
  await ensureProjectGit(projectId);
  const dest = timelinePath(projectId);
  let state: TimelineState;
  if (fsSync.existsSync(dest)) {
    try {
      const raw = JSON.parse(await fs.readFile(dest, "utf8")) as TimelineState;
      if (raw?.version === 1 && Array.isArray(raw.branches) && Array.isArray(raw.nodes)) {
        state = raw;
      } else {
        state = emptyMain();
      }
    } catch {
      state = emptyMain();
    }
  } else {
    state = emptyMain();
    state = await migrateFromGit(projectId, state);
    await saveTimeline(projectId, state);
  }
  return state;
}

export function isBranchPruned(branch: TimelineBranch): boolean {
  return Boolean(branch.prunedAt);
}

export function assertBranchAccessible(branch: TimelineBranch, action = "use"): void {
  if (isBranchPruned(branch)) {
    throw err(410, `Branch “${branch.name}” was pruned and cannot be ${action}`);
  }
}

type Mutex = { run<T>(fn: () => Promise<T>): Promise<T> };

function createMutex(): Mutex {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const next = tail.then(fn, fn);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}

const timelineLocks = new Map<string, Mutex>();

function withTimelineLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  let lock = timelineLocks.get(projectId);
  if (!lock) {
    lock = createMutex();
    timelineLocks.set(projectId, lock);
  }
  return lock.run(fn);
}

export type DestructiveOpSafetyOpts = {
  /**
   * Host nuclear option: kick connected collab editors instead of refusing.
   * Live public shares and AI links still block (revoke those explicitly).
   */
  forceKickEditors?: boolean;
};

/**
 * Fail-safes before soft-prune or delete-forever in collaborative settings.
 * Blocks live public shares, live AI sandboxes / parent tips, and open/connecting collab rooms
 * (unless `forceKickEditors` — then rooms are torn down by the caller after this assert).
 */
export async function assertTipSafeForDestructiveOp(
  projectId: string,
  branchId: string,
  op: "prune" | "delete",
  opts?: DestructiveOpSafetyOpts,
): Promise<void> {
  const verb = op === "prune" ? "pruning" : "deleting";

  const { listSharesForProject } = await import("./share.js");
  const { ensureAiList, isAiLinkDead } = await import("./aiShare.js");
  for (const session of listSharesForProject(projectId)) {
    if (session.status !== "active" && session.status !== "starting") continue;

    if (session.branchId === branchId) {
      const guestCount = session.guests?.size ?? 0;
      throw err(
        409,
        guestCount > 0
          ? `End the public share on this tip first — ${guestCount} guest${guestCount === 1 ? " is" : "s are"} still on it`
          : `End the public share on this tip before ${verb} it`,
      );
    }

    for (const ai of ensureAiList(session)) {
      if (isAiLinkDead(session, ai)) continue;
      if (ai.branchId === branchId) {
        throw err(
          409,
          `AI collaborator “${ai.branchName}” is still live on this tip — revoke the AI link before ${verb} it`,
        );
      }
      if (ai.parentBranchId === branchId) {
        throw err(
          409,
          `AI collaborator “${ai.branchName}” was forked from this tip and is still live — revoke it (or end the share) before ${verb}`,
        );
      }
    }
  }

  if (opts?.forceKickEditors) return;

  const {
    getRoom,
    awaitRoomCreating,
    isRoomCreating,
  } = await import("./collab/room.js");
  if (isRoomCreating(projectId, branchId)) {
    await awaitRoomCreating(projectId, branchId);
  }
  const room = getRoom(projectId, branchId);
  if (room && !room.isDead && room.clientCount > 0) {
    const n = room.clientCount;
    throw err(
      409,
      `${n} editor${n === 1 ? " is" : "s are"} still connected to this tip — switch everyone (including yourself) to another tip before ${verb}`,
    );
  }
}

async function cleanupCollabForDeletedTip(projectId: string, branchId: string): Promise<void> {
  const { forceDestroyBranchRoom, sealBranchRoom } = await import("./collab/room.js");
  sealBranchRoom(projectId, branchId);
  await forceDestroyBranchRoom(projectId, branchId, { skipFlush: true });
}

/** Visible timeline for UI: pruned tips (and their nodes) are omitted. */
function visibleTimelineState(state: TimelineState, opts?: { includePruned?: boolean }): TimelineState {
  if (opts?.includePruned) return state;
  const branches = state.branches.filter((b) => !isBranchPruned(b));
  const keep = new Set(branches.map((b) => b.id));
  const nodes = state.nodes.filter((n) => keep.has(n.branchId));
  let activeBranchId = state.activeBranchId;
  if (!keep.has(activeBranchId)) {
    activeBranchId = keep.has("main") ? "main" : (branches[0]?.id ?? "main");
  }
  let viewingNodeId = state.viewingNodeId;
  if (viewingNodeId && !nodes.some((n) => n.id === viewingNodeId)) {
    viewingNodeId = null;
  }
  return { ...state, branches, nodes, activeBranchId, viewingNodeId };
}

/**
 * Older merges only stored the receiving parent. Recover the source tip from
 * git's second parent so the timeline can draw a merge arrow.
 */
async function enrichMergeParentsFromGit(
  projectId: string,
  state: TimelineState,
): Promise<boolean> {
  if (!isGitEnabled()) return false;
  const candidates = state.nodes.filter(
    (n) => !n.mergeParentId && /^Merge\b/i.test(n.message) && n.gitHash,
  );
  if (candidates.length === 0) return false;

  const byHash = new Map<string, TimelineNode>();
  for (const n of state.nodes) {
    if (!n.gitHash) continue;
    byHash.set(n.gitHash, n);
    if (n.gitHash.length >= 7) byHash.set(n.gitHash.slice(0, 7), n);
  }

  let dirty = false;
  for (const node of candidates) {
    const rev = await runGit(projectId, ["rev-list", "--parents", "-n", "1", node.gitHash], {
      allowFailure: true,
    });
    if (rev.code !== 0) continue;
    const parts = rev.stdout.trim().split(/\s+/).filter(Boolean);
    // "<commit> <parent1> <parent2> ..."
    if (parts.length < 3) continue;
    const second = parts[2]!;
    const match =
      byHash.get(second) ??
      (second.length >= 7 ? byHash.get(second.slice(0, 7)) : undefined);
    if (!match || match.id === node.id || match.id === node.parentId) continue;
    node.mergeParentId = match.id;
    dirty = true;
  }
  return dirty;
}

export async function getTimelineView(
  projectId: string,
  opts?: { branchId?: string; includePruned?: boolean; skipGitSync?: boolean },
): Promise<TimelineView> {
  if (opts?.skipGitSync !== true) {
    await syncTimelineFromGit(projectId);
  }
  const raw = await loadTimeline(projectId);
  // Fill missing mergeParentId from git's second parent so older merges still draw.
  if (await enrichMergeParentsFromGit(projectId, raw)) {
    await saveTimeline(projectId, raw);
  }
  const state = visibleTimelineState(raw, { includePruned: opts?.includePruned });
  const branchId = opts?.branchId ?? state.activeBranchId;
  const activeBranch = state.branches.find((b) => b.id === branchId);
  if (!activeBranch) {
    // Requested branch may be pruned / unknown in the filtered view.
    const rawBranch = raw.branches.find((b) => b.id === branchId);
    if (rawBranch && isBranchPruned(rawBranch)) {
      throw err(410, `Branch “${rawBranch.name}” was pruned and is no longer accessible`);
    }
    throw err(404, `Unknown branch: ${branchId}`);
  }

  const headNode = activeBranch.headNodeId
    ? state.nodes.find((n) => n.id === activeBranch.headNodeId) ?? null
    : null;
  const viewingNodeId =
    opts?.branchId && opts.branchId !== state.activeBranchId
      ? null
      : state.viewingNodeId;
  const viewingNode = viewingNodeId
    ? state.nodes.find((n) => n.id === viewingNodeId) ?? null
    : null;

  const atTip = !viewingNode || viewingNode.id === activeBranch.headNodeId;
  const canEdit = atTip;
  const dirty = canEdit ? await isWorkingTreeDirty(projectId, branchId) : false;
  const viewingGitHash = canEdit ? null : viewingNode?.gitHash ?? null;

  return {
    ...state,
    activeBranchId: opts?.branchId ?? state.activeBranchId,
    viewingNodeId: viewingNode?.id ?? null,
    dirty,
    canEdit,
    activeBranch,
    headNode,
    viewingNode,
    viewingGitHash,
  };
}

export function getBranch(state: TimelineState, branchId: string): TimelineBranch {
  const b = state.branches.find((x) => x.id === branchId);
  if (!b) throw err(404, `Unknown branch: ${branchId}`);
  return b;
}

/** Filesystem root for a branch’s working copy. Refuses pruned tips. */
export async function ensureBranchRoot(projectId: string, branchId: string): Promise<string> {
  const state = await loadTimeline(projectId);
  const branch = getBranch(state, branchId);
  assertBranchAccessible(branch, "opened");

  if (branchId === "main" || branch.sacred) {
    return projectDir(projectId);
  }

  const wt = worktreePath(projectId, branchId);
  if (fsSync.existsSync(wt)) return wt;

  await fs.mkdir(path.dirname(wt), { recursive: true });
  // Prefer existing git ref; otherwise create from head commit.
  const head = branch.headNodeId
    ? state.nodes.find((n) => n.id === branch.headNodeId)
    : null;
  const start = head?.gitHash || "HEAD";

  const list = await runGit(projectId, ["show-ref", "--verify", `refs/heads/${branch.gitRef}`], {
    allowFailure: true,
  });
  if (list.code !== 0) {
    await runGit(projectId, ["branch", branch.gitRef, start], { allowFailure: true });
  }

  const add = await runGit(projectId, ["worktree", "add", wt, branch.gitRef], { allowFailure: true });
  if (add.code !== 0) {
    // Branch may already be checked out in another worktree — try detached
    const addDetached = await runGit(projectId, ["worktree", "add", "--detach", wt, start], {
      allowFailure: true,
    });
    if (addDetached.code !== 0) {
      throw err(500, `Could not create worktree for ${branch.name}: ${add.stderr || addDetached.stderr}`);
    }
  }
  return wt;
}

export async function isWorkingTreeDirty(projectId: string, branchId: string): Promise<boolean> {
  if (!isGitEnabled()) return false;
  try {
    const state = await loadTimeline(projectId);
    const branch = getBranch(state, branchId);
    const root =
      branchId === "main" || branch.sacred
        ? projectDir(projectId)
        : worktreePath(projectId, branchId);
    if (!fsSync.existsSync(root)) return false;
    const st = await runGit(projectId, ["status", "--porcelain"], { cwd: root, allowFailure: true });
    return Boolean(st.stdout.trim());
  } catch {
    return false;
  }
}

export async function intentionalCommit(
  projectId: string,
  opts: { branchId: string; message: string; author?: GitAuthor },
): Promise<{ timeline: TimelineView; node: TimelineNode; hash: string }> {
  if (!isGitEnabled()) throw err(400, "Git is disabled");
  const message = opts.message.trim();
  if (!message) throw err(400, "Commit message is required");

  await syncTimelineFromGit(projectId);
  const state = await loadTimeline(projectId);
  const branch = getBranch(state, opts.branchId);
  assertBranchAccessible(branch, "committed to");

  // Guests / host must be at the tip to commit
  if (state.activeBranchId === opts.branchId && state.viewingNodeId) {
    const head = branch.headNodeId;
    if (state.viewingNodeId !== head) {
      throw err(400, "Cannot commit while viewing a historical checkpoint — return to the tip or fork first");
    }
  }

  const root = await ensureBranchRoot(projectId, opts.branchId);
  await runGit(projectId, ["add", "-A"], { cwd: root, author: opts.author });
  const status = await runGit(projectId, ["status", "--porcelain"], { cwd: root, allowFailure: true });
  if (!status.stdout.trim()) throw err(400, "Nothing to commit — working copy is clean");

  const commit = await runGit(projectId, ["commit", "-m", message, "--no-gpg-sign"], {
    cwd: root,
    author: opts.author,
    allowFailure: true,
  });
  if (commit.code !== 0) {
    throw err(500, commit.stderr || commit.stdout || "Commit failed");
  }

  const rev = await runGit(projectId, ["rev-parse", "HEAD"], { cwd: root });
  const hash = rev.stdout.trim();
  // Keep the named branch tip in sync even if the worktree was added detached.
  if (branch.gitRef) {
    await runGit(projectId, ["update-ref", `refs/heads/${branch.gitRef}`, hash], {
      cwd: projectDir(projectId),
      allowFailure: true,
    });
  }
  const node: TimelineNode = {
    id: `n-${crypto.randomBytes(6).toString("hex")}`,
    branchId: branch.id,
    parentId: branch.headNodeId,
    gitHash: hash,
    message,
    author: opts.author?.name?.trim() || "OpenLeaf",
    createdAt: new Date().toISOString(),
  };
  state.nodes.push(node);
  branch.headNodeId = node.id;
  if (state.activeBranchId === branch.id) state.viewingNodeId = null;
  await saveTimeline(projectId, state);

  return {
    node,
    hash,
    timeline: await getTimelineView(projectId, { branchId: branch.id }),
  };
}

export async function forkBranch(
  projectId: string,
  opts: { fromNodeId: string; name: string; /** Default true. AI sandboxes pass false so the host tip stays active. */ activate?: boolean },
): Promise<{ timeline: TimelineView; branch: TimelineBranch }> {
  const name = opts.name.trim();
  if (!/^[a-zA-Z0-9._/-]{1,64}$/.test(name) || name === "main") {
    throw err(400, "Fork name must be 1–64 chars (letters, numbers, . _ / -) and not “main”");
  }
  await syncTimelineFromGit(projectId);
  const state = await loadTimeline(projectId);
  if (state.branches.some((b) => b.name === name || b.id === name)) {
    throw err(409, `Branch “${name}” already exists`);
  }

  const from = state.nodes.find((n) => n.id === opts.fromNodeId);
  if (!from) throw err(404, "Checkpoint not found");
  const fromBranch = getBranch(state, from.branchId);
  assertBranchAccessible(fromBranch, "forked from");

  const id = name.replace(/\//g, "-");
  const gitRef = name.startsWith("ol/") ? name : `ol/${name}`;
  const now = new Date().toISOString();

  await ensureProjectGit(projectId);
  const created = await runGit(projectId, ["branch", gitRef, from.gitHash], { allowFailure: true });
  if (created.code !== 0) {
    throw err(500, created.stderr || "Could not create git branch");
  }

  const headNode: TimelineNode = {
    id: `n-${crypto.randomBytes(6).toString("hex")}`,
    branchId: id,
    parentId: from.id,
    gitHash: from.gitHash,
    message: `Fork “${name}” from ${from.message.slice(0, 40)}`,
    author: "OpenLeaf",
    createdAt: now,
  };

  const branch: TimelineBranch = {
    id,
    name,
    sacred: false,
    headNodeId: headNode.id,
    createdAt: now,
    gitRef,
  };

  state.branches.push(branch);
  state.nodes.push(headNode);
  if (opts.activate !== false) {
    state.activeBranchId = branch.id;
    state.viewingNodeId = null;
  }
  await saveTimeline(projectId, state);

  // Materialize worktree for the new branch
  await ensureBranchRoot(projectId, branch.id);

  return {
    branch,
    timeline: await getTimelineView(projectId, { branchId: branch.id }),
  };
}

/**
 * Soft-prune a tip: hide the branch from the timeline and block access.
 * Does not delete git data or worktrees. Sacred main cannot be pruned.
 * Only tips (branch heads) are prunable — the whole tip lineage is hidden with the branch.
 */
export async function pruneBranchTip(
  projectId: string,
  branchId: string,
  opts?: DestructiveOpSafetyOpts,
): Promise<TimelineView> {
  return withTimelineLock(projectId, async () => {
    const { sealBranchRoom } = await import("./collab/room.js");
    // Seal early so in-flight room creates cannot win a race with this prune.
    sealBranchRoom(projectId, branchId);
    try {
      await assertTipSafeForDestructiveOp(projectId, branchId, "prune", opts);

      const state = await loadTimeline(projectId);
      const branch = getBranch(state, branchId);
      if (branch.sacred || branch.id === "main") {
        throw err(400, "Cannot prune the sacred main tip");
      }
      if (isBranchPruned(branch)) {
        throw err(400, `Tip “${branch.name}” is already pruned`);
      }
      if (!branch.headNodeId) {
        throw err(400, "Branch has no tip to prune");
      }

      // Re-check after load — editors may have connected while we waited.
      await assertTipSafeForDestructiveOp(projectId, branchId, "prune", opts);

      // Kick first when forcing so clientCount cannot race the prune mark.
      if (opts?.forceKickEditors) {
        await cleanupCollabForDeletedTip(projectId, branchId);
      }

      branch.prunedAt = new Date().toISOString();
      if (state.activeBranchId === branchId) {
        state.activeBranchId = "main";
        state.viewingNodeId = null;
      }
      await saveTimeline(projectId, state);
      await cleanupCollabForDeletedTip(projectId, branchId);
      try {
        const { bumpProjectLeavesVersion } = await import("./collab/room.js");
        bumpProjectLeavesVersion(projectId);
      } catch {
        /* optional */
      }
      return getTimelineView(projectId, { skipGitSync: true });
    } catch (e) {
      // Only unseal if we did not successfully mark the tip pruned.
      try {
        const state = await loadTimeline(projectId);
        const branch = state.branches.find((b) => b.id === branchId);
        if (!branch || !isBranchPruned(branch)) {
          const { unsealBranchRoom } = await import("./collab/room.js");
          unsealBranchRoom(projectId, branchId);
        }
      } catch {
        const { unsealBranchRoom } = await import("./collab/room.js");
        unsealBranchRoom(projectId, branchId);
      }
      throw e;
    }
  });
}

export type PrunedTipInfo = {
  branchId: string;
  name: string;
  prunedAt: string;
  headNodeId: string | null;
  tipHash: string | null;
  tipMessage: string | null;
  nodeCount: number;
};

/** Soft-pruned tips for the trash bin (still on disk). */
export async function listPrunedTips(projectId: string): Promise<PrunedTipInfo[]> {
  const state = await loadTimeline(projectId);
  const out: PrunedTipInfo[] = [];
  for (const branch of state.branches) {
    if (!isBranchPruned(branch) || !branch.prunedAt) continue;
    const head = branch.headNodeId
      ? state.nodes.find((n) => n.id === branch.headNodeId) ?? null
      : null;
    out.push({
      branchId: branch.id,
      name: branch.name,
      prunedAt: branch.prunedAt,
      headNodeId: branch.headNodeId,
      tipHash: head?.gitHash ?? null,
      tipMessage: head?.message ?? null,
      nodeCount: state.nodes.filter((n) => n.branchId === branch.id).length,
    });
  }
  out.sort((a, b) => b.prunedAt.localeCompare(a.prunedAt));
  return out;
}

/** Restore a soft-pruned tip to the timeline. */
export async function unpruneBranchTip(
  projectId: string,
  branchId: string,
): Promise<TimelineView> {
  return withTimelineLock(projectId, async () => {
    const state = await loadTimeline(projectId);
    const branch = getBranch(state, branchId);
    if (!isBranchPruned(branch)) {
      throw err(400, `Tip “${branch.name}” is not in the trash`);
    }
    branch.prunedAt = null;
    await saveTimeline(projectId, state);
    try {
      const { unsealBranchRoom } = await import("./collab/room.js");
      unsealBranchRoom(projectId, branchId);
    } catch {
      /* optional */
    }
    return getTimelineView(projectId, { skipGitSync: true });
  });
}

/**
 * Permanently delete a pruned tip: remove timeline branch + nodes, worktree, and git ref.
 * Requires the tip to already be in the trash (pruned). Sacred main cannot be deleted.
 */
export async function deletePrunedBranchForever(
  projectId: string,
  branchId: string,
  opts?: DestructiveOpSafetyOpts & { discardDirty?: boolean },
): Promise<{ ok: true; timeline: TimelineView; deleted: { branchId: string; name: string } }> {
  return withTimelineLock(projectId, async () => {
    const { sealBranchRoom, unsealBranchRoom } = await import("./collab/room.js");
    sealBranchRoom(projectId, branchId);
    try {
      const state = await loadTimeline(projectId);
      const branch = getBranch(state, branchId);
      if (branch.sacred || branch.id === "main") {
        throw err(400, "Cannot delete the sacred main tip");
      }
      if (!isBranchPruned(branch)) {
        throw err(400, "Move the tip to the trash (prune) before deleting forever");
      }

      await assertTipSafeForDestructiveOp(projectId, branchId, "delete", opts);

      // Tear down any leftover room before touching the worktree (avoids locked dirs / hung git).
      await cleanupCollabForDeletedTip(projectId, branchId);

      const dirty = await isWorkingTreeDirty(projectId, branchId);
      if (dirty && !opts?.discardDirty) {
        throw err(
          409,
          "This tip still has uncommitted edits on disk — restore & commit, or confirm discard to delete forever",
        );
      }

      const deleted = { branchId: branch.id, name: branch.name };
      const wt = worktreePath(projectId, branchId);

      // Detach worktree from git, then wipe the directory.
      if (fsSync.existsSync(wt)) {
        await runGit(projectId, ["worktree", "remove", "--force", wt], { allowFailure: true });
        try {
          await fs.rm(wt, { recursive: true, force: true });
        } catch (rmErr) {
          // WSL / open handles: retry once after a short pause.
          await new Promise((r) => setTimeout(r, 250));
          try {
            await fs.rm(wt, { recursive: true, force: true });
          } catch {
            throw err(
              500,
              `Could not remove worktree for “${branch.name}” — close editors using that tip and try again (${
                rmErr instanceof Error ? rmErr.message : "rm failed"
              })`,
            );
          }
        }
      }

      if (branch.gitRef && branch.gitRef !== "main") {
        await runGit(projectId, ["branch", "-D", branch.gitRef], { allowFailure: true });
      }

      state.branches = state.branches.filter((b) => b.id !== branchId);
      state.nodes = state.nodes.filter((n) => n.branchId !== branchId);
      if (state.activeBranchId === branchId) {
        state.activeBranchId = "main";
        state.viewingNodeId = null;
      } else if (state.viewingNodeId && !state.nodes.some((n) => n.id === state.viewingNodeId)) {
        state.viewingNodeId = null;
      }
      await saveTimeline(projectId, state);
      await cleanupCollabForDeletedTip(projectId, branchId);
      unsealBranchRoom(projectId, branchId);
      try {
        const { bumpProjectLeavesVersion } = await import("./collab/room.js");
        bumpProjectLeavesVersion(projectId);
      } catch {
        /* optional */
      }

      return { ok: true, timeline: await getTimelineView(projectId, { skipGitSync: true }), deleted };
    } catch (e) {
      // Keep seal if tip remains pruned; clear if we aborted before deletion completed
      // and tip still exists pruned (seal should stay) or was never pruned.
      try {
        const state = await loadTimeline(projectId);
        const branch = state.branches.find((b) => b.id === branchId);
        if (!branch) unsealBranchRoom(projectId, branchId);
        else if (!isBranchPruned(branch)) unsealBranchRoom(projectId, branchId);
      } catch {
        /* keep seal */
      }
      throw e;
    }
  });
}

/**
 * Host navigation: select a node or branch tip.
 * Non-head nodes → read-only view. Head → editable working copy.
 */
export async function checkoutTimeline(
  projectId: string,
  opts: { branchId?: string; nodeId?: string | null },
): Promise<TimelineView> {
  const state = await loadTimeline(projectId);

  if (opts.branchId) {
    const target = getBranch(state, opts.branchId);
    assertBranchAccessible(target, "opened");
    state.activeBranchId = opts.branchId;
  }

  const branch = getBranch(state, state.activeBranchId);
  assertBranchAccessible(branch, "opened");

  if (opts.nodeId === null || opts.nodeId === undefined) {
    state.viewingNodeId = null;
  } else {
    const node = state.nodes.find((n) => n.id === opts.nodeId);
    if (!node) throw err(404, "Checkpoint not found");
    if (node.branchId !== branch.id && opts.branchId === undefined) {
      // Jump to that node’s branch
      const jump = getBranch(state, node.branchId);
      assertBranchAccessible(jump, "opened");
      state.activeBranchId = node.branchId;
    }
    const b = getBranch(state, state.activeBranchId);
    assertBranchAccessible(b, "opened");
    if (node.branchId !== b.id) throw err(400, "Node is not on the selected branch");
    state.viewingNodeId = node.id === b.headNodeId ? null : node.id;
  }

  await saveTimeline(projectId, state);

  // Tip WC stays untouched when viewing history; only ensure it exists for editable tips.
  if (!state.viewingNodeId) {
    await ensureBranchRoot(projectId, state.activeBranchId);
  }

  return getTimelineView(projectId);
}

const HASH_RE = /^[0-9a-f]{7,40}$/i;

function assertCommitHash(hash: string): string {
  if (!HASH_RE.test(hash)) throw err(400, "Invalid commit hash");
  return hash;
}

/** File tree as of a historical commit (does not touch the working copy). */
export async function listTreeAtCommit(projectId: string, hash: string): Promise<TreeNode[]> {
  await ensureProjectGit(projectId);
  const h = assertCommitHash(hash);
  const listed = await runGit(projectId, ["ls-tree", "-r", "--name-only", h], { allowFailure: true });
  if (listed.code !== 0) throw err(404, "Commit not found");
  const paths = listed.stdout
    .split("\n")
    .map((l) => l.trim().replace(/\\/g, "/"))
    .filter((p) => p && !p.startsWith(".openleaf/") && !p.startsWith(".git/"));

  type Dir = { name: string; path: string; type: "directory"; children: Map<string, Dir | TreeNode> };
  const root: Dir = { name: "", path: "", type: "directory", children: new Map() };

  for (const rel of paths) {
    const parts = rel.split("/").filter(Boolean);
    let cur = root;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      const childPath = parts.slice(0, i + 1).join("/");
      const isFile = i === parts.length - 1;
      if (isFile) {
        cur.children.set(part, { name: part, path: childPath, type: "file" });
      } else {
        let next = cur.children.get(part) as Dir | undefined;
        if (!next || next.type !== "directory") {
          next = { name: part, path: childPath, type: "directory", children: new Map() };
          cur.children.set(part, next);
        }
        cur = next;
      }
    }
  }

  function freeze(dir: Dir): TreeNode[] {
    return [...dir.children.values()]
      .sort((a, b) => {
        const ad = a.type === "directory" ? 0 : 1;
        const bd = b.type === "directory" ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return a.name.localeCompare(b.name);
      })
      .map((n) =>
        n.type === "directory"
          ? { name: n.name, path: n.path, type: "directory" as const, children: freeze(n as Dir) }
          : { name: n.name, path: n.path, type: "file" as const },
      );
  }

  return freeze(root);
}

/** Read one file blob from a historical commit. */
export async function readFileAtCommit(
  projectId: string,
  hash: string,
  relativePath: string,
  opts?: { forceText?: boolean },
): Promise<{
  encoding: "utf8" | "base64";
  content: string;
  contentType: string;
  size: number;
  text: boolean;
  contentOmitted?: boolean;
}> {
  await ensureProjectGit(projectId);
  const h = assertCommitHash(hash);
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((p) => p === "..")) {
    throw err(400, "Invalid path");
  }

  const probe = await runGit(projectId, ["cat-file", "-e", `${h}:${normalized}`], { allowFailure: true });
  if (probe.code !== 0) throw err(404, "File not found in that checkpoint");

  const sizeOut = await runGit(projectId, ["cat-file", "-s", `${h}:${normalized}`], { allowFailure: true });
  const size = Number(sizeOut.stdout.trim()) || 0;

  if (size > MAX_INLINE_FILE_BYTES) {
    const asText = Boolean(opts?.forceText || isTextPath(normalized));
    return {
      encoding: asText ? "utf8" : "base64",
      content: "",
      contentType: asText ? "text/plain; charset=utf-8" : "application/octet-stream",
      size,
      text: asText,
      contentOmitted: true,
    };
  }

  // Fetch exact bytes for binary-safe content.
  const { stdout } = await execFileAsync("git", ["cat-file", "-p", `${h}:${normalized}`], {
    cwd: projectDir(projectId),
    encoding: "buffer",
    maxBuffer: MAX_INLINE_FILE_BYTES + 1024,
    timeout: 30_000,
  });
  const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout));
  const text = Boolean(opts?.forceText || isTextPath(normalized, buf));
  if (text) {
    return {
      encoding: "utf8",
      content: buf.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
      contentType: "text/plain; charset=utf-8",
      size: buf.length,
      text: true,
    };
  }
  return {
    encoding: "base64",
    content: buf.toString("base64"),
    contentType: "application/octet-stream",
    size: buf.length,
    text: false,
  };
}

/** Seed a tip commit if the project has files but no nodes yet. */
export async function ensureTimelineSeed(projectId: string, author?: GitAuthor): Promise<void> {
  const state = await loadTimeline(projectId);
  if (state.nodes.length > 0) return;
  if (!isGitEnabled()) return;

  const result = await autoCommitProject(projectId, {
    message: "Initial checkpoint",
    author,
  });
  if (!result.committed || !result.hash) return;

  const node: TimelineNode = {
    id: `n-${crypto.randomBytes(6).toString("hex")}`,
    branchId: "main",
    parentId: null,
    gitHash: result.hash,
    message: "Initial checkpoint",
    author: author?.name ?? "OpenLeaf",
    createdAt: new Date().toISOString(),
  };
  const main = getBranch(state, "main");
  main.headNodeId = node.id;
  state.nodes.push(node);
  await saveTimeline(projectId, state);
}
