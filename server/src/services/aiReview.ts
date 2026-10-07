import {
  alignEof,
  applySingleHunk,
  computeHunks,
  hasCrlf,
  hashHunk,
  hunkAdditions,
  hunkDeletions,
  hunkNewRanges,
  inlineDiff,
  mergeInlineTokens,
  normalizeLf,
  phraseFrom,
  toCrlf,
  type InlineRange,
  type InlineToken,
  type PatchLine,
  type TextHunk,
} from "./textPatch.js";
import { deletePath, MAX_TEXT_FILE_BYTES, readFile, resolveRootPath, writeFile } from "./projectFs.js";
import { ensureBranchRoot } from "./timeline.js";
import {
  ingestProjectDiskPaths,
  notifyProjectAiReview,
  notifyProjectTreeChange,
} from "./collab/room.js";

export type ReviewCtx = {
  projectId: string;
  aiId: string;
  branchId: string;
  slug: string;
  branchName: string;
  parentBranchName: string;
  /** Who is accepting or rejecting. Omitted callers are the local host. */
  actor?: import("./fileAccess.js").FileAccessActor;
};

type ReviewState = {
  /** Content before the first un-accepted AI write (LF). `null` = the file did not exist. */
  baselines: Map<string, string | null>;
  /** Paths whose original bytes used CRLF — restore that convention on reject. */
  crlf: Set<string>;
  touched: Set<string>;
};

const states = new Map<string, ReviewState>();

function state(aiId: string): ReviewState {
  let st = states.get(aiId);
  if (!st) {
    st = { baselines: new Map(), crlf: new Set(), touched: new Set() };
    states.set(aiId, st);
  }
  return st;
}

export function clearAiReview(aiId: string): void {
  states.delete(aiId);
}

export function snapshotBeforeWrite(aiId: string, path: string, before: string | null): void {
  const st = state(aiId);
  if (!st.baselines.has(path)) {
    if (before != null && hasCrlf(before)) st.crlf.add(path);
    st.baselines.set(path, before == null ? null : normalizeLf(before));
  }
  st.touched.add(path);
}

export type ReviewHunkView = {
  id: string;
  path: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  additions: number;
  deletions: number;
  lines: PatchLine[];
  /** Word-level tokens for a Grammarly-style card (context clipped). */
  inline: InlineToken[];
  /** Changed spans in the current (new) file, 1-based Monaco ranges. */
  ranges: InlineRange[];
  phraseBefore: string;
  phraseAfter: string;
  kind: "replace" | "insert" | "delete";
};

export type ReviewFileView = {
  path: string;
  status: "modified" | "added" | "deleted";
  additions: number;
  deletions: number;
  hunks: ReviewHunkView[];
};

export type ReviewCollaboratorView = {
  aiId: string;
  slug: string;
  branchId: string;
  branchName: string;
  parentBranchName: string;
  hunkCount: number;
  fileCount: number;
  additions: number;
  deletions: number;
  files: ReviewFileView[];
};

function hunkId(path: string, h: TextHunk): string {
  return `${path}#${hashHunk(path, h)}`;
}

function changedSides(h: TextHunk): { before: string; after: string } {
  return {
    before: h.lines.filter((l) => l.kind === "del").map((l) => l.text).join("\n"),
    after: h.lines.filter((l) => l.kind === "add").map((l) => l.text).join("\n"),
  };
}

function toView(path: string, h: TextHunk): ReviewHunkView {
  // Diff only added/removed lines — including hunk context lets Myers match
  // glue words ("the", "on") across rewritten sentences and produces a soup.
  const { before, after } = changedSides(h);
  const tokens = mergeInlineTokens(inlineDiff(before, after));
  const phraseBefore = phraseFrom(tokens, "del");
  const phraseAfter = phraseFrom(tokens, "add");
  const kind: ReviewHunkView["kind"] =
    phraseBefore && phraseAfter ? "replace" : phraseAfter ? "insert" : "delete";
  const ranges = hunkNewRanges(h);
  return {
    id: hunkId(path, h),
    path,
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    additions: hunkAdditions(h),
    deletions: hunkDeletions(h),
    lines: h.lines,
    inline: mergeInlineTokens(tokens),
    ranges:
      ranges.length > 0
        ? ranges
        : [
            {
              startLine: Math.max(1, h.newStart),
              startColumn: 1,
              endLine: Math.max(1, h.newStart),
              endColumn: 1,
            },
          ],
    phraseBefore,
    phraseAfter,
    kind,
  };
}

async function sandboxRoot(ctx: ReviewCtx): Promise<string> {
  return ensureBranchRoot(ctx.projectId, ctx.branchId);
}

async function readCurrent(ctx: ReviewCtx, rel: string): Promise<string | null> {
  const root = await sandboxRoot(ctx);
  try {
    resolveRootPath(root, rel);
    const file = await readFile(ctx.projectId, rel, {
      forceText: true,
      rootDir: root,
      maxBytes: MAX_TEXT_FILE_BYTES,
    });
    if (file.contentOmitted) return null;
    if (!file.text) return null;
    return normalizeLf(file.content);
  } catch (err) {
    const status = err && typeof err === "object" && "status" in err ? (err as { status: number }).status : 0;
    if (status === 404) return null;
    throw err;
  }
}

async function writeCurrent(ctx: ReviewCtx, rel: string, content: string | null): Promise<void> {
  const { assertCanWrite } = await import("./fileAccess.js");
  await assertCanWrite(ctx.projectId, rel, ctx.actor ?? "local");
  const root = await sandboxRoot(ctx);
  if (content == null) {
    try {
      await deletePath(ctx.projectId, rel, root);
    } catch (err) {
      const status = err && typeof err === "object" && "status" in err ? (err as { status: number }).status : 0;
      if (status !== 404) throw err;
    }
    notifyProjectTreeChange(ctx.projectId, { op: "delete", path: rel }, ctx.branchId);
    return;
  }
  const disk = state(ctx.aiId).crlf.has(rel) ? toCrlf(content) : content;
  await writeFile(ctx.projectId, rel, disk, "utf8", root);
  try {
    await ingestProjectDiskPaths(ctx.projectId, [rel], ctx.branchId);
  } catch (err) {
    console.error("[ai-review] collab ingest after write failed", err);
  }
}

function fileStatus(baseline: string | null, current: string | null): ReviewFileView["status"] {
  if (baseline == null && current != null) return "added";
  if (current == null) return baseline == null ? "modified" : "deleted";
  if (baseline == null) return "added";
  return "modified";
}

function buildFile(path: string, baseline: string | null, current: string | null): ReviewFileView | null {
  if (baseline === current) return null;
  const oldT = baseline ?? "";
  const newT = current ?? "";
  const hunks = computeHunks(oldT, newT);
  if (hunks.length === 0 && oldT === newT) return null;
  if (hunks.length === 0) {
    // eof-only / identical lines — still a pending change
    return {
      path,
      status: fileStatus(baseline, current),
      additions: 0,
      deletions: 0,
      hunks: [],
    };
  }
  const views = hunks.map((h) => toView(path, h));
  return {
    path,
    status: fileStatus(baseline, current),
    additions: views.reduce((n, h) => n + h.additions, 0),
    deletions: views.reduce((n, h) => n + h.deletions, 0),
    hunks: views,
  };
}

export async function listAiReview(ctx: ReviewCtx): Promise<ReviewCollaboratorView> {
  const st = state(ctx.aiId);
  const files: ReviewFileView[] = [];
  for (const path of [...st.touched].sort()) {
    const baseline = st.baselines.has(path) ? (st.baselines.get(path) as string | null) : null;
    const current = await readCurrent(ctx, path);
    const file = buildFile(path, baseline, current);
    if (file) files.push(file);
  }
  const hunkCount = files.reduce((n, f) => n + Math.max(f.hunks.length, 1), 0);
  return {
    aiId: ctx.aiId,
    slug: ctx.slug,
    branchId: ctx.branchId,
    branchName: ctx.branchName,
    parentBranchName: ctx.parentBranchName,
    hunkCount,
    fileCount: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    files,
  };
}

function findHunk(
  files: ReviewFileView[],
  hunkIdValue: string,
): { file: ReviewFileView; hunk: ReviewHunkView } | null {
  for (const file of files) {
    const hunk = file.hunks.find((h) => h.id === hunkIdValue);
    if (hunk) return { file, hunk };
  }
  return null;
}

function asTextHunk(h: ReviewHunkView): TextHunk {
  return {
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines,
  };
}

export async function acceptAiHunk(ctx: ReviewCtx, hunkIdValue: string): Promise<ReviewCollaboratorView> {
  const before = await listAiReview(ctx);
  const found = findHunk(before.files, hunkIdValue);
  if (!found) {
    throw Object.assign(new Error("Hunk not found or already reviewed"), { status: 404, code: "HUNK_NOT_FOUND" });
  }
  const st = state(ctx.aiId);
  const stored = st.baselines.has(found.file.path) ? (st.baselines.get(found.file.path) as string | null) : null;
  const current = await readCurrent(ctx, found.file.path);
  let nextBaseline = applySingleHunk(stored ?? "", asTextHunk(found.hunk), false);
  const currentText = current ?? "";
  nextBaseline = alignEof(nextBaseline, currentText);
  if (computeHunks(nextBaseline, currentText).length === 0) {
    nextBaseline = currentText;
  }
  st.baselines.set(found.file.path, current == null && nextBaseline === "" ? null : nextBaseline);
  notifyProjectAiReview(ctx.projectId);
  return listAiReview(ctx);
}

export async function rejectAiHunk(ctx: ReviewCtx, hunkIdValue: string): Promise<ReviewCollaboratorView> {
  const before = await listAiReview(ctx);
  const found = findHunk(before.files, hunkIdValue);
  if (!found) {
    throw Object.assign(new Error("Hunk not found or already reviewed"), { status: 404, code: "HUNK_NOT_FOUND" });
  }
  const current = await readCurrent(ctx, found.file.path);
  const next = applySingleHunk(current ?? "", asTextHunk(found.hunk), true);
  const stored = state(ctx.aiId).baselines.has(found.file.path)
    ? (state(ctx.aiId).baselines.get(found.file.path) as string | null)
    : null;
  if (next === "" && stored == null) {
    await writeCurrent(ctx, found.file.path, null);
  } else {
    await writeCurrent(ctx, found.file.path, next);
  }
  notifyProjectAiReview(ctx.projectId);
  return listAiReview(ctx);
}

export async function acceptAiFile(ctx: ReviewCtx, path: string): Promise<ReviewCollaboratorView> {
  const st = state(ctx.aiId);
  if (!st.touched.has(path)) {
    throw Object.assign(new Error("No pending AI changes for that file"), { status: 404 });
  }
  st.baselines.set(path, await readCurrent(ctx, path));
  notifyProjectAiReview(ctx.projectId);
  return listAiReview(ctx);
}

export async function rejectAiFile(ctx: ReviewCtx, path: string): Promise<ReviewCollaboratorView> {
  const st = state(ctx.aiId);
  if (!st.touched.has(path)) {
    throw Object.assign(new Error("No pending AI changes for that file"), { status: 404 });
  }
  const stored = st.baselines.has(path) ? (st.baselines.get(path) as string | null) : null;
  await writeCurrent(ctx, path, stored);
  notifyProjectAiReview(ctx.projectId);
  return listAiReview(ctx);
}

export async function acceptAiAll(ctx: ReviewCtx): Promise<ReviewCollaboratorView> {
  const st = state(ctx.aiId);
  for (const path of st.touched) {
    st.baselines.set(path, await readCurrent(ctx, path));
  }
  notifyProjectAiReview(ctx.projectId);
  return listAiReview(ctx);
}

export async function rejectAiAll(ctx: ReviewCtx): Promise<ReviewCollaboratorView> {
  const st = state(ctx.aiId);
  for (const path of [...st.touched]) {
    const stored = st.baselines.has(path) ? (st.baselines.get(path) as string | null) : null;
    await writeCurrent(ctx, path, stored);
  }
  notifyProjectAiReview(ctx.projectId);
  return listAiReview(ctx);
}

export function reviewCtxFromAi(
  projectId: string,
  ai: {
    id: string;
    slug: string;
    branchId: string;
    branchName: string;
    parentBranchName: string;
  },
): ReviewCtx {
  return {
    projectId,
    aiId: ai.id,
    branchId: ai.branchId,
    slug: ai.slug,
    branchName: ai.branchName,
    parentBranchName: ai.parentBranchName,
  };
}
