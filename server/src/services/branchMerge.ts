import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { projectDir } from "./projectFs.js";
import {
  ensureBranchRoot,
  getBranch,
  getTimelineView,
  isBranchPruned,
  loadTimeline,
  type TimelineView,
} from "./timeline.js";
import { ensureProjectGit, isGitEnabled, type GitAuthor } from "./projectGit.js";

const execFileAsync = promisify(execFile);

export type MergeConflictFile = {
  path: string;
  /** Git unmerged status code pair, e.g. "UU", "AA", "DU", "UD" */
  code: string;
  kind: "both-modified" | "both-added" | "deleted-by-us" | "deleted-by-them" | "other";
  resolved: boolean;
  strategy?: "ours" | "theirs" | "manual";
  binary?: boolean;
};

export type MergeSession = {
  id: string;
  projectId: string;
  targetBranchId: string;
  targetBranchName: string;
  sourceBranchId: string;
  sourceBranchName: string;
  targetHash: string;
  sourceHash: string;
  status: "in_progress" | "ready" | "completed" | "aborted";
  conflicts: MergeConflictFile[];
  /** Non-conflict paths staged by the merge (auto-merged). */
  autoMerged: string[];
  message: string;
  startedAt: string;
};

export type MergeFileSides = {
  path: string;
  binary: boolean;
  ours: string | null;
  theirs: string | null;
  base: string | null;
  /** Working-tree content (may include conflict markers). */
  working: string | null;
  resolved: boolean;
  strategy?: MergeConflictFile["strategy"];
};

function err(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function mergeStatePath(projectId: string): string {
  return path.join(projectDir(projectId), ".openleaf", "merge-session.json");
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
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
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

function classifyConflict(code: string): MergeConflictFile["kind"] {
  if (code === "UU" || code === "AA") return code === "AA" ? "both-added" : "both-modified";
  if (code === "DU") return "deleted-by-us";
  if (code === "UD") return "deleted-by-them";
  return "other";
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

async function saveSession(session: MergeSession): Promise<void> {
  const dest = mergeStatePath(session.projectId);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, JSON.stringify(session, null, 2) + "\n", "utf8");
}

async function readSession(projectId: string): Promise<MergeSession | null> {
  try {
    const raw = await fs.readFile(mergeStatePath(projectId), "utf8");
    return JSON.parse(raw) as MergeSession;
  } catch {
    return null;
  }
}

async function clearSession(projectId: string): Promise<void> {
  try {
    await fs.unlink(mergeStatePath(projectId));
  } catch {
    /* missing ok */
  }
}

async function gitDirAbs(projectId: string, cwd: string): Promise<string> {
  const gitDir = await runGit(projectId, ["rev-parse", "--git-dir"], { cwd, allowFailure: true });
  const raw = gitDir.stdout.trim() || ".git";
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

async function hasMergeHead(projectId: string, cwd: string): Promise<boolean> {
  const abs = await gitDirAbs(projectId, cwd);
  return fsSync.existsSync(path.join(abs, "MERGE_HEAD"));
}

/** True when a host merge is waiting for resolve/complete. */
export async function hasActiveMerge(projectId: string): Promise<boolean> {
  const session = await readSession(projectId);
  return Boolean(session && (session.status === "in_progress" || session.status === "ready"));
}

export async function assertNoActiveMerge(projectId: string): Promise<void> {
  if (await hasActiveMerge(projectId)) {
    throw err(409, "A merge is in progress — finish or abort it first");
  }
}

async function parseUnmerged(projectId: string, cwd: string): Promise<MergeConflictFile[]> {
  const st = await runGit(projectId, ["status", "--porcelain=1", "-uall"], {
    cwd,
    allowFailure: true,
  });
  const out: MergeConflictFile[] = [];
  for (const line of st.stdout.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    // Unmerged: second char is U, or UU/AA/DD, or DU/UD/AU/UA
    const unmerged =
      code.includes("U") || code === "AA" || code === "DD" || code === "AU" || code === "UA";
    if (!unmerged) continue;
    const filePath = line.slice(3).replace(/^"+|"+$/g, "").trim();
    if (!filePath || filePath.includes(".openleaf/")) continue;
    out.push({
      path: filePath,
      code,
      kind: classifyConflict(code),
      resolved: false,
    });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function listAutoMerged(projectId: string, cwd: string, conflicts: Set<string>): Promise<string[]> {
  const st = await runGit(projectId, ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    cwd,
    allowFailure: true,
  });
  return st.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((p) => p && !conflicts.has(p) && !p.includes(".openleaf/"))
    .sort();
}

async function readStageBlob(
  projectId: string,
  cwd: string,
  stage: 1 | 2 | 3,
  filePath: string,
): Promise<{ text: string | null; binary: boolean; missing: boolean }> {
  const show = await runGit(projectId, ["show", `:${stage}:${filePath}`], {
    cwd,
    allowFailure: true,
  });
  if (show.code !== 0) return { text: null, binary: false, missing: true };
  const buf = Buffer.from(show.stdout, "utf8");
  // git show may corrupt binary via string — use cat-file for binary detection
  const cat = await runGit(projectId, ["cat-file", "-p", `:${stage}:${filePath}`], {
    cwd,
    allowFailure: true,
  });
  const raw = Buffer.from(cat.stdout ?? show.stdout, "binary");
  if (looksBinary(raw)) return { text: null, binary: true, missing: false };
  return { text: raw.toString("utf8"), binary: false, missing: false };
}

/**
 * Start merging source branch tip into target branch tip (host must be on target tip).
 * Leaves the target worktree in a conflicted or staged merge state until complete/abort.
 */
export async function startBranchMerge(
  projectId: string,
  opts: { sourceBranchId: string; targetBranchId?: string; author?: GitAuthor },
): Promise<MergeSession> {
  if (!isGitEnabled()) throw err(400, "Git is disabled");
  await ensureProjectGit(projectId);

  const existing = await readSession(projectId);
  if (existing && (existing.status === "in_progress" || existing.status === "ready")) {
    throw err(409, "A merge is already in progress — finish or abort it first");
  }

  const state = await loadTimeline(projectId);
  const targetBranchId = opts.targetBranchId ?? state.activeBranchId;
  const source = getBranch(state, opts.sourceBranchId);
  const target = getBranch(state, targetBranchId);

  if (isBranchPruned(source) || isBranchPruned(target)) {
    throw err(410, "Cannot merge a pruned tip — it is no longer accessible");
  }

  if (source.id === target.id) throw err(400, "Cannot merge a branch into itself");
  if (!source.headNodeId || !target.headNodeId) {
    throw err(400, "Both branches need at least one committed leaf before merging");
  }
  if (state.activeBranchId !== target.id || state.viewingNodeId) {
    throw err(400, "Check out the target branch tip before merging into it");
  }

  const sourceHead = state.nodes.find((n) => n.id === source.headNodeId);
  const targetHead = state.nodes.find((n) => n.id === target.headNodeId);
  if (!sourceHead || !targetHead) throw err(500, "Missing branch tip nodes");

  const root = await ensureBranchRoot(projectId, target.id);
  await ensureBranchRoot(projectId, source.id);

  // Refuse dirty target WC (uncommitted human edits).
  const dirty = await runGit(projectId, ["status", "--porcelain"], { cwd: root, allowFailure: true });
  if (dirty.stdout.trim()) {
    throw err(400, "Target working copy has uncommitted changes — commit or discard them first");
  }

  // Abort leftover merge state if any.
  if (await hasMergeHead(projectId, root)) {
    await runGit(projectId, ["merge", "--abort"], { cwd: root, allowFailure: true });
  }

  const merge = await runGit(
    projectId,
    ["merge", "--no-ff", "--no-commit", sourceHead.gitHash],
    { cwd: root, allowFailure: true, author: opts.author },
  );

  // Already up to date
  if (/Already up to date/i.test(merge.stdout + merge.stderr)) {
    throw err(400, "Already up to date — nothing to merge");
  }

  const conflicts = await parseUnmerged(projectId, root);
  const conflictSet = new Set(conflicts.map((c) => c.path));
  const autoMerged = await listAutoMerged(projectId, root, conflictSet);

  // Failed for other reasons (not conflicts)
  if (merge.code !== 0 && conflicts.length === 0) {
    await runGit(projectId, ["merge", "--abort"], { cwd: root, allowFailure: true });
    throw err(500, merge.stderr || merge.stdout || "Merge failed");
  }

  // Mark binary flags
  for (const c of conflicts) {
    const ours = await readStageBlob(projectId, root, 2, c.path);
    const theirs = await readStageBlob(projectId, root, 3, c.path);
    c.binary = ours.binary || theirs.binary;
  }

  const session: MergeSession = {
    id: `m-${crypto.randomBytes(6).toString("hex")}`,
    projectId,
    targetBranchId: target.id,
    targetBranchName: target.name,
    sourceBranchId: source.id,
    sourceBranchName: source.name,
    targetHash: targetHead.gitHash,
    sourceHash: sourceHead.gitHash,
    status: conflicts.length ? "in_progress" : "ready",
    conflicts,
    autoMerged,
    message: `Merge branch “${source.name}” into ${target.name}`,
    startedAt: new Date().toISOString(),
  };
  await saveSession(session);
  return session;
}

export async function getBranchMerge(projectId: string): Promise<MergeSession | null> {
  const session = await readSession(projectId);
  if (!session || session.status === "completed" || session.status === "aborted") return null;
  const root = await ensureBranchRoot(projectId, session.targetBranchId);
  // Orphaned OpenLeaf session with no live git merge — clear so the host isn't stuck.
  if (!(await hasMergeHead(projectId, root))) {
    await clearSession(projectId);
    return null;
  }
  // Refresh resolved flags from git index
  const still = await parseUnmerged(projectId, root);
  const stillSet = new Set(still.map((c) => c.path));
  for (const c of session.conflicts) {
    if (!stillSet.has(c.path) && !c.resolved) {
      c.resolved = true;
      c.strategy = c.strategy ?? "manual";
    }
    // Still unmerged in git → not resolved (even if session said so)
    if (stillSet.has(c.path) && c.resolved) {
      c.resolved = false;
      c.strategy = undefined;
    }
  }
  session.status = session.conflicts.every((c) => c.resolved) ? "ready" : "in_progress";
  await saveSession(session);
  return session;
}

export async function getMergeConflictFile(
  projectId: string,
  filePath: string,
): Promise<MergeFileSides> {
  const session = await getBranchMerge(projectId);
  if (!session) throw err(404, "No merge in progress");
  const entry = session.conflicts.find((c) => c.path === filePath);
  if (!entry) throw err(404, "Not a conflicted file in this merge");

  const root = await ensureBranchRoot(projectId, session.targetBranchId);
  const base = await readStageBlob(projectId, root, 1, filePath);
  const ours = await readStageBlob(projectId, root, 2, filePath);
  const theirs = await readStageBlob(projectId, root, 3, filePath);
  const binary = Boolean(entry.binary || ours.binary || theirs.binary || base.binary);

  let working: string | null = null;
  if (!binary) {
    try {
      working = await fs.readFile(path.join(root, filePath), "utf8");
    } catch {
      working = null;
    }
  }

  return {
    path: filePath,
    binary,
    ours: ours.missing ? null : ours.text,
    theirs: theirs.missing ? null : theirs.text,
    base: base.missing ? null : base.text,
    working,
    resolved: entry.resolved,
    strategy: entry.strategy,
  };
}

export async function resolveMergeConflict(
  projectId: string,
  opts: {
    path: string;
    strategy: "ours" | "theirs" | "manual";
    content?: string;
  },
): Promise<MergeSession> {
  const session = await getBranchMerge(projectId);
  if (!session) throw err(404, "No merge in progress");
  const entry = session.conflicts.find((c) => c.path === opts.path);
  if (!entry) throw err(404, "Not a conflicted file in this merge");

  const root = await ensureBranchRoot(projectId, session.targetBranchId);
  const rel = opts.path.replace(/^\/+/, "");
  if (rel.split("/").some((p) => p === "..")) throw err(400, "Invalid path");

  if (opts.strategy === "ours") {
    const checkout = await runGit(projectId, ["checkout", "--ours", "--", rel], {
      cwd: root,
      allowFailure: true,
    });
    if (checkout.code !== 0) {
      // Deleted by us: keep the deletion.
      if (entry.kind === "deleted-by-us" || entry.code === "DU") {
        await runGit(projectId, ["rm", "-f", "--", rel], { cwd: root, allowFailure: true });
      } else {
        throw err(500, checkout.stderr || "Could not take ours");
      }
    } else {
      await runGit(projectId, ["add", "--", rel], { cwd: root, allowFailure: true });
    }
  } else if (opts.strategy === "theirs") {
    const checkout = await runGit(projectId, ["checkout", "--theirs", "--", rel], {
      cwd: root,
      allowFailure: true,
    });
    if (checkout.code !== 0) {
      // Deleted by them: accept the deletion.
      if (entry.kind === "deleted-by-them" || entry.code === "UD") {
        await runGit(projectId, ["rm", "-f", "--", rel], { cwd: root, allowFailure: true });
      } else {
        throw err(500, checkout.stderr || "Could not take theirs");
      }
    } else {
      await runGit(projectId, ["add", "--", rel], { cwd: root, allowFailure: true });
    }
  } else {
    if (entry.binary) throw err(400, "Binary conflicts must use ours or theirs");
    if (typeof opts.content !== "string") throw err(400, "Manual resolve requires content");
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, opts.content, "utf8");
    await runGit(projectId, ["add", "--", rel], { cwd: root });
  }

  entry.resolved = true;
  entry.strategy = opts.strategy;
  session.status = session.conflicts.every((c) => c.resolved) ? "ready" : "in_progress";
  await saveSession(session);
  return session;
}

export async function completeBranchMerge(
  projectId: string,
  opts?: { message?: string; author?: GitAuthor },
): Promise<{ session: MergeSession; timeline: TimelineView; hash: string; nodeId: string }> {
  const session = await getBranchMerge(projectId);
  if (!session) throw err(404, "No merge in progress");
  if (session.conflicts.some((c) => !c.resolved)) {
    throw err(400, "Resolve all conflicts before completing the merge");
  }

  const state = await loadTimeline(projectId);
  if (state.activeBranchId !== session.targetBranchId || state.viewingNodeId) {
    throw err(400, "Check out the merge target tip before completing");
  }
  const target = getBranch(state, session.targetBranchId);
  const root = await ensureBranchRoot(projectId, target.id);
  if (!(await hasMergeHead(projectId, root))) {
    await clearSession(projectId);
    throw err(409, "Merge state was lost — start the merge again");
  }

  const message = (opts?.message ?? session.message).trim() || session.message;
  const commit = await runGit(projectId, ["commit", "-m", message, "--no-gpg-sign", "--no-edit"], {
    cwd: root,
    author: opts?.author,
    allowFailure: true,
  });
  // If merge staged nothing weirdly
  if (commit.code !== 0) {
    // Try with --allow-empty only if needed? Prefer fail.
    throw err(500, commit.stderr || commit.stdout || "Merge commit failed");
  }

  const rev = await runGit(projectId, ["rev-parse", "HEAD"], { cwd: root });
  const hash = rev.stdout.trim();
  // Keep the named branch tip in sync even if the worktree was detached.
  await runGit(projectId, ["update-ref", `refs/heads/${target.gitRef}`, hash], {
    cwd: projectDir(projectId),
    allowFailure: true,
  });
  const nodeId = `n-${crypto.randomBytes(6).toString("hex")}`;
  const source = getBranch(state, session.sourceBranchId);
  state.nodes.push({
    id: nodeId,
    branchId: target.id,
    parentId: target.headNodeId,
    mergeParentId: source.headNodeId,
    gitHash: hash,
    message,
    author: opts?.author?.name?.trim() || "OpenLeaf",
    createdAt: new Date().toISOString(),
  });
  target.headNodeId = nodeId;
  if (state.activeBranchId === target.id) state.viewingNodeId = null;
  await saveTimeline(projectId, state);

  session.status = "completed";
  await clearSession(projectId);

  return {
    session: { ...session, status: "completed", message },
    timeline: await getTimelineView(projectId, { branchId: target.id }),
    hash,
    nodeId,
  };
}

export async function abortBranchMerge(
  projectId: string,
): Promise<{ ok: true; timeline: TimelineView; targetBranchId: string }> {
  const session = await readSession(projectId);
  const state = await loadTimeline(projectId);
  const targetId = session?.targetBranchId ?? state.activeBranchId;
  const root = await ensureBranchRoot(projectId, targetId);
  await runGit(projectId, ["merge", "--abort"], { cwd: root, allowFailure: true });
  // Also reset any half-staged state
  await runGit(projectId, ["reset", "--merge"], { cwd: root, allowFailure: true });
  await clearSession(projectId);
  return {
    ok: true,
    targetBranchId: targetId,
    timeline: await getTimelineView(projectId, { branchId: targetId }),
  };
}

// Re-export saveTimeline via load+write already in timeline — need saveTimeline
async function saveTimeline(
  projectId: string,
  state: Awaited<ReturnType<typeof loadTimeline>>,
): Promise<void> {
  const dest = path.join(projectDir(projectId), ".openleaf", "timeline.json");
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, JSON.stringify(state, null, 2) + "\n", "utf8");
}
