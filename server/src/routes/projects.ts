import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { z, ZodError } from "zod";
import { compileProject } from "../services/compiler.js";
import {
  clearCollabSnapshot,
  flushProjectRoom,
  getOrCreateRoom,
  notifyProjectCommentsChanged,
  notifyProjectTreeChange,
  reseedProjectRoom,
} from "../services/collab/room.js";
import {
  addCommentReply,
  CommentAnchorSchema,
  createComment,
  deleteComment,
  guestMayMutateComment,
  listComments,
  patchComment,
} from "../services/comments.js";
import {
  autoCommitProject,
  listProjectCommits,
  restoreProjectCommit,
  type GitAuthor,
} from "../services/projectGit.js";
import {
  createEmptyFile,
  createProject,
  deletePath,
  getProject,
  getProjectIdentities,
  getProjectIdentity,
  getTree,
  isGuestForbiddenWritePath,
  listProjects,
  mkdirPath,
  pdfPathAbs,
  readFile,
  readProjectConfig,
  renamePath,
  writeFile,
  writeProjectConfig,
} from "../services/projectFs.js";
import { resolveBranchIdWithActive, branchRoot } from "../services/branchContext.js";
import { listBranchLeafStats } from "../services/branchLeaves.js";
import { computeDiffHighlights } from "../services/diffHighlights.js";
import { forwardSynctex, reverseSynctex } from "../services/synctex.js";
import { streamProjectZip } from "../services/zip.js";
import { IdentitySchema } from "../config.js";
import type { Access } from "../services/shareAuth.js";
import { publicErrorMessage } from "../http/jsonErrors.js";
import { projectShareRouter } from "./share.js";
import { projectAiRouter, projectAiShareRouter } from "./ai.js";
import { citeIntoProject } from "../services/library/cite.js";

export const projectsRouter = Router();
const filesRouter = Router({ mergeParams: true });
projectsRouter.use("/:id/ai", projectAiRouter);
projectsRouter.use("/:id/share/ai", projectAiShareRouter);
projectsRouter.use("/:id/share", projectShareRouter);

function statusOf(err: unknown): number {
  if (err instanceof ZodError) return 400;
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return 500;
}

function rejectGuestProtectedWrite(req: { access?: Access }, rel: string, res: { status: (code: number) => { json: (body: unknown) => void } }): boolean {
  if (req.access?.mode === "guest" && isGuestForbiddenWritePath(rel)) {
    res.status(403).json({ error: "This path is not writable through a share link" });
    return true;
  }
  return false;
}

async function authorFromRequest(
  projectId: string,
  req: { body?: unknown; query?: unknown; headers: Record<string, unknown>; access?: Access },
): Promise<GitAuthor | undefined> {
  // Guests arriving through a share link are attributed by the name they signed in with.
  if (req.access?.mode === "guest") {
    const g = req.access.guest;
    return { name: g.name, email: `${g.id}@guest.openleaf.local` };
  }
  const header = req.headers["x-openleaf-identity"];
  const fromHeader = typeof header === "string" ? header : undefined;
  const body = req.body && typeof req.body === "object" ? (req.body as { identityId?: string }) : {};
  const query = req.query && typeof req.query === "object" ? (req.query as { identity?: string }) : {};
  const id = body.identityId || query.identity || fromHeader;
  if (!id) return undefined;
  const ident = await getProjectIdentity(projectId, id);
  if (!ident) return undefined;
  return { name: ident.name, email: `${ident.id}@openleaf.local` };
}

async function commitAfterChange(
  _id: string,
  _message: string,
  _req: { body?: unknown; query?: unknown; headers: Record<string, unknown> },
  _paths?: string[],
) {
  // Autosave / FS mutations update the working copy only.
  // Intentional history nodes are created via POST /timeline/commit.
  return { committed: false, hash: null, message: "", skipped: "disabled" as const };
}

async function identityFromRequest(
  projectId: string,
  req: { body?: unknown; query?: unknown; headers: Record<string, unknown>; access?: Access },
) {
  // Guests are attributed by the name/color they signed in with.
  if (req.access?.mode === "guest") {
    const g = req.access.guest;
    return { id: g.id, name: g.name, color: g.color };
  }
  const header = req.headers["x-openleaf-identity"];
  const fromHeader = typeof header === "string" ? header : undefined;
  const body = req.body && typeof req.body === "object" ? (req.body as { identityId?: string }) : {};
  const query = req.query && typeof req.query === "object" ? (req.query as { identity?: string }) : {};
  const id = body.identityId || query.identity || fromHeader;
  if (!id) {
    throw Object.assign(new Error("identityId is required"), { status: 400 });
  }
  const ident = await getProjectIdentity(projectId, id);
  if (!ident) {
    throw Object.assign(new Error("Unknown identity"), { status: 403 });
  }
  return ident;
}

projectsRouter.get("/", async (_req, res) => {
  try {
    res.json(await listProjects());
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/", async (req, res) => {
  const schema = z.object({
    id: z.string().regex(/^[a-zA-Z0-9._-]+$/),
    fromTemplate: z.string().optional(),
  });
  try {
    const body = schema.parse(req.body);
    const project = await createProject(body.id, body.fromTemplate ?? "example-article");
    res.status(201).json(project);
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.get("/:id", async (req, res) => {
  try {
    res.json(await getProject(req.params.id));
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.get("/:id/tree", async (req, res) => {
  try {
    const at = typeof req.query.at === "string" ? req.query.at : undefined;
    if (at) {
      const { listTreeAtCommit } = await import("../services/timeline.js");
      res.json(await listTreeAtCommit(req.params.id, at));
      return;
    }
    const branchId = await resolveBranchIdWithActive(req, req.params.id);
    const root = await branchRoot(req.params.id, branchId);
    res.json(await getTree(req.params.id, root));
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

filesRouter.get(/.*/, async (req, res) => {
  try {
    const id = String(req.params.id);
    const rel = decodeURIComponent(req.path.replace(/^\//, ""));
    if (!rel) {
      res.status(400).json({ error: "Missing file path" });
      return;
    }
    const forceText = req.query.forceText === "1" || req.query.forceText === "true";
    const at = typeof req.query.at === "string" ? req.query.at : undefined;
    if (at) {
      const { readFileAtCommit } = await import("../services/timeline.js");
      const file = await readFileAtCommit(id, at, rel, { forceText });
      res.json({ path: rel, ...file });
      return;
    }
    const branchId = await resolveBranchIdWithActive(req, id);
    const root = await branchRoot(id, branchId);
    const file = await readFile(id, rel, { forceText, rootDir: root });
    res.json({ path: rel, ...file });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

filesRouter.put(/.*/, async (req, res) => {
  const schema = z.object({
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]).optional(),
  });
  try {
    const id = String(req.params.id);
    const body = schema.parse(req.body);
    const rel = decodeURIComponent(req.path.replace(/^\//, ""));
    if (!rel) {
      res.status(400).json({ error: "Missing file path" });
      return;
    }
    if (rejectGuestProtectedWrite(req, rel, res)) return;
    const branchId = await resolveBranchIdWithActive(req, id, { mutate: true });
    const root = await branchRoot(id, branchId);
    await writeFile(id, rel, body.content, body.encoding ?? "utf8", root);
    if ((body.encoding ?? "utf8") === "utf8") {
      notifyProjectTreeChange(id, { op: "write", path: rel }, branchId);
    }
    const git = await commitAfterChange(id, `Save ${rel}`, req);
    res.json({ ok: true, path: rel, git });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

filesRouter.delete(/.*/, async (req, res) => {
  try {
    const id = String(req.params.id);
    const rel = decodeURIComponent(req.path.replace(/^\//, ""));
    if (!rel) {
      res.status(400).json({ error: "Missing file path" });
      return;
    }
    if (rejectGuestProtectedWrite(req, rel, res)) return;
    const branchId = await resolveBranchIdWithActive(req, id, { mutate: true });
    const root = await branchRoot(id, branchId);
    await deletePath(id, rel, root);
    notifyProjectTreeChange(id, { op: "delete", path: rel }, branchId);
    const git = await commitAfterChange(id, `Delete ${rel}`, req);
    res.json({ ok: true, path: rel, git });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.use("/:id/files", filesRouter);

projectsRouter.get("/:id/identities", async (req, res) => {
  try {
    res.json(await getProjectIdentities(req.params.id));
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.put("/:id/identities", async (req, res) => {
  try {
    const identities = z.array(IdentitySchema).min(1).parse(req.body);
    const seen = new Set<string>();
    for (const i of identities) {
      if (seen.has(i.id)) {
        res.status(400).json({ error: `Duplicate identity id: ${i.id}` });
        return;
      }
      seen.add(i.id);
    }
    const cfg = await writeProjectConfig(req.params.id, { identities });
    res.json(cfg.identities ?? identities);
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.get("/:id/comments", async (req, res) => {
  try {
    res.json(await listComments(req.params.id));
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

/** Sync a library citekey into the project's .bib (and optionally insert \\cite{}). */
projectsRouter.post("/:id/library/cite", async (req, res) => {
  const schema = z.object({
    citekey: z.string().min(1),
    file: z.string().min(1).optional(),
    line: z.number().int().positive().optional(),
  });
  try {
    if (req.access?.mode === "guest") {
      res.status(403).json({ error: "Citation library cite is host-only" });
      return;
    }
    const body = schema.parse(req.body);
    const result = await citeIntoProject(req.params.id, body);
    notifyProjectTreeChange(req.params.id, { op: "write", path: result.bibFile });
    if (result.inserted && body.file) {
      notifyProjectTreeChange(req.params.id, { op: "write", path: body.file });
    }
    res.json(result);
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/:id/comments", async (req, res) => {
  const schema = z.object({
    identityId: z.string().min(1),
    body: z.string().min(1).max(8000),
    anchor: CommentAnchorSchema,
  });
  try {
    const body = schema.parse(req.body);
    const ident = await identityFromRequest(req.params.id, req);
    const thread = await createComment(req.params.id, {
      author: ident,
      body: body.body,
      anchor: body.anchor,
    });
    notifyProjectCommentsChanged(req.params.id);
    notifyProjectTreeChange(req.params.id, { op: "write", path: "comments.json" });
    const git = await commitAfterChange(
      req.params.id,
      `Comment on ${thread.anchor.file}:${thread.anchor.line}`,
      req,
      ["comments.json"],
    );
    res.status(201).json({ thread, git });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/:id/comments/:commentId/replies", async (req, res) => {
  const schema = z.object({
    identityId: z.string().min(1),
    body: z.string().min(1).max(8000),
  });
  try {
    const body = schema.parse(req.body);
    const ident = await identityFromRequest(req.params.id, req);
    const thread = await addCommentReply(req.params.id, req.params.commentId, {
      author: ident,
      body: body.body,
    });
    notifyProjectCommentsChanged(req.params.id);
    const git = await commitAfterChange(
      req.params.id,
      `Reply on ${thread.anchor.file}:${thread.anchor.line}`,
      req,
      ["comments.json"],
    );
    res.status(201).json({ thread, git });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.patch("/:id/comments/:commentId", async (req, res) => {
  const schema = z.object({
    identityId: z.string().optional(),
    resolved: z.boolean().optional(),
    body: z.string().min(1).max(8000).optional(),
  });
  try {
    const body = schema.parse(req.body);
    const existing = (await listComments(req.params.id)).find((t) => t.id === req.params.commentId);
    if (!existing) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    const kind = body.body !== undefined ? "edit-body" : "resolve";
    if (!guestMayMutateComment(req.access, existing, kind)) {
      res.status(403).json({ error: "You can only edit comments you wrote" });
      return;
    }
    const thread = await patchComment(req.params.id, req.params.commentId, {
      resolved: body.resolved,
      body: body.body,
    });
    notifyProjectCommentsChanged(req.params.id);
    const label =
      typeof body.resolved === "boolean"
        ? body.resolved
          ? "Resolve"
          : "Reopen"
        : "Edit";
    const git = await commitAfterChange(
      req.params.id,
      `${label} comment on ${thread.anchor.file}:${thread.anchor.line}`,
      req,
      ["comments.json"],
    );
    res.json({ thread, git });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.delete("/:id/comments/:commentId", async (req, res) => {
  try {
    const threads = await listComments(req.params.id);
    const existing = threads.find((t) => t.id === req.params.commentId);
    if (!existing) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    if (!guestMayMutateComment(req.access, existing, "delete")) {
      res.status(403).json({ error: "You can only delete comments you wrote" });
      return;
    }
    await deleteComment(req.params.id, req.params.commentId);
    notifyProjectCommentsChanged(req.params.id);
    const git = await commitAfterChange(
      req.params.id,
      existing
        ? `Delete comment on ${existing.anchor.file}:${existing.anchor.line}`
        : "Delete comment",
      req,
      ["comments.json"],
    );
    res.json({ ok: true, git });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/:id/collab/flush", async (req, res) => {
  const schema = z
    .object({
      identityId: z.string().optional(),
      message: z.string().optional(),
      branchId: z.string().optional(),
    })
    .optional();
  try {
    const body = schema.parse(req.body ?? {});
    const branchId = await resolveBranchIdWithActive(req, req.params.id, {
      bodyBranchId: body?.branchId,
      mutate: true,
    });
    const git = await flushProjectRoom(req.params.id, {
      author: await authorFromRequest(req.params.id, req),
      message: body?.message ?? "Save & sync",
      commit: false,
      branchId,
    });
    res.json({ ok: true, git });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/:id/collab/ensure", async (req, res) => {
  const schema = z.object({ path: z.string().min(1), branchId: z.string().optional() });
  try {
    const body = schema.parse(req.body);
    // Guests may ensure files on an observed branch (read-only room); hosts use active/requested.
    const branchId = await resolveBranchIdWithActive(req, req.params.id, {
      bodyBranchId: body.branchId,
    });
    const room = await getOrCreateRoom(req.params.id, branchId);
    await room.ensureFile(body.path);
    res.json({ ok: true, path: body.path });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.get("/:id/diff-highlights", async (req, res) => {
  try {
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    const at = typeof req.query.at === "string" ? req.query.at : undefined;
    const branchId = await resolveBranchIdWithActive(req, req.params.id);
    const result = await computeDiffHighlights(req.params.id, since, branchId, at);
    res.json(result);
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.get("/:id/branch-leaves", async (req, res) => {
  try {
    res.json(await listBranchLeafStats(req.params.id));
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});
projectsRouter.get("/:id/history", async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const commits = await listProjectCommits(req.params.id, Number.isFinite(limit) ? limit : 50);
    res.json(commits);
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/:id/history/restore", async (req, res) => {
  const schema = z.object({
    hash: z.string().min(7),
    identityId: z.string().optional(),
  });
  try {
    const body = schema.parse(req.body);
    const author = await authorFromRequest(req.params.id, req);
    await flushProjectRoom(req.params.id, {
      author,
      message: "Pre-restore save",
      commit: false,
    });
    await restoreProjectCommit(req.params.id, body.hash);
    // Stale CRDT snapshot must not undo the restore on next room open
    await clearCollabSnapshot(req.params.id);
    await reseedProjectRoom(req.params.id);
    notifyProjectTreeChange(req.params.id, { op: "bump" });
    res.json({ ok: true });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.get("/:id/timeline", async (req, res) => {
  try {
    const { getTimelineView } = await import("../services/timeline.js");
    const branchId =
      typeof req.query.branchId === "string"
        ? req.query.branchId
        : req.access?.mode === "guest"
          ? req.access.session.branchId
          : undefined;
    const view = await getTimelineView(req.params.id, branchId ? { branchId } : undefined);
    res.json(view);
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/:id/timeline/commit", async (req, res) => {
  const schema = z.object({
    message: z.string().min(1),
    branchId: z.string().optional(),
    identityId: z.string().optional(),
  });
  try {
    const body = schema.parse(req.body);
    const { intentionalCommit } = await import("../services/timeline.js");
    const { assertNoActiveMerge } = await import("../services/branchMerge.js");
    await assertNoActiveMerge(req.params.id);
    const branchId =
      body.branchId ||
      (req.access?.mode === "guest" ? req.access.session.branchId : undefined) ||
      "main";
    if (req.access?.mode === "guest" && req.access.session.branchId !== branchId) {
      res.status(403).json({ error: "This share link can only commit on its bound branch" });
      return;
    }
    // Flush working copy first (no auto-commit)
    await flushProjectRoom(req.params.id, {
      author: await authorFromRequest(req.params.id, req),
      commit: false,
      branchId,
    });
    const result = await intentionalCommit(req.params.id, {
      branchId,
      message: body.message,
      author: await authorFromRequest(req.params.id, req),
    });
    notifyProjectTreeChange(req.params.id, { op: "bump" }, branchId);
    res.json(result);
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/:id/timeline/fork", async (req, res) => {
  const schema = z.object({
    fromNodeId: z.string().min(1),
    name: z.string().min(1),
  });
  try {
    if (req.access?.mode === "guest") {
      res.status(403).json({ error: "Only the host can fork a new branch" });
      return;
    }
    const { assertNoActiveMerge } = await import("../services/branchMerge.js");
    await assertNoActiveMerge(req.params.id);
    const body = schema.parse(req.body);
    const { forkBranch } = await import("../services/timeline.js");
    const result = await forkBranch(req.params.id, body);
    res.status(201).json(result);
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/:id/timeline/prune", async (req, res) => {
  const schema = z.object({
    branchId: z.string().min(1),
    /** Kick connected editors instead of refusing (host nuclear option). */
    forceKickEditors: z.boolean().optional(),
  });
  try {
    if (req.access?.mode === "guest") {
      res.status(403).json({ error: "Only the host can prune a tip" });
      return;
    }
    const { assertNoActiveMerge } = await import("../services/branchMerge.js");
    await assertNoActiveMerge(req.params.id);
    const body = schema.parse(req.body ?? {});
    const { pruneBranchTip } = await import("../services/timeline.js");
    const timeline = await pruneBranchTip(req.params.id, body.branchId, {
      forceKickEditors: body.forceKickEditors === true,
    });
    const { bumpProjectLeavesVersion } = await import("../services/collab/room.js");
    bumpProjectLeavesVersion(req.params.id);
    // Fan-out to every live room so other hosts refresh (no branchId → all rooms).
    notifyProjectTreeChange(req.params.id, { op: "bump" });
    res.json({ ok: true, timeline });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.get("/:id/timeline/trash", async (req, res) => {
  try {
    if (req.access?.mode === "guest") {
      res.status(403).json({ error: "Only the host can view the trash" });
      return;
    }
    const { listPrunedTips } = await import("../services/timeline.js");
    res.json({ items: await listPrunedTips(req.params.id) });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/:id/timeline/unprune", async (req, res) => {
  const schema = z.object({
    branchId: z.string().min(1),
  });
  try {
    if (req.access?.mode === "guest") {
      res.status(403).json({ error: "Only the host can restore a tip" });
      return;
    }
    const body = schema.parse(req.body ?? {});
    const { unpruneBranchTip } = await import("../services/timeline.js");
    const timeline = await unpruneBranchTip(req.params.id, body.branchId);
    notifyProjectTreeChange(req.params.id, { op: "bump" }, timeline.activeBranchId);
    res.json({ ok: true, timeline });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/:id/timeline/trash/delete", async (req, res) => {
  const schema = z.object({
    branchId: z.string().min(1),
    /** Must equal the branch name to confirm permanent deletion. */
    confirmName: z.string().min(1),
    forceKickEditors: z.boolean().optional(),
    /** Wipe uncommitted worktree edits along with the tip. */
    discardDirty: z.boolean().optional(),
  });
  try {
    if (req.access?.mode === "guest") {
      res.status(403).json({ error: "Only the host can delete tips forever" });
      return;
    }
    const { assertNoActiveMerge } = await import("../services/branchMerge.js");
    await assertNoActiveMerge(req.params.id);
    const body = schema.parse(req.body ?? {});
    const { loadTimeline, getBranch, deletePrunedBranchForever } = await import("../services/timeline.js");
    const state = await loadTimeline(req.params.id);
    const branch = getBranch(state, body.branchId);
    if (body.confirmName.trim() !== branch.name) {
      res.status(400).json({
        error: `Type the exact tip name “${branch.name}” to confirm permanent deletion`,
      });
      return;
    }
    const result = await deletePrunedBranchForever(req.params.id, body.branchId, {
      forceKickEditors: body.forceKickEditors === true,
      discardDirty: body.discardDirty === true,
    });
    const { bumpProjectLeavesVersion } = await import("../services/collab/room.js");
    bumpProjectLeavesVersion(req.params.id);
    notifyProjectTreeChange(req.params.id, { op: "bump" });
    res.json(result);
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/:id/timeline/checkout", async (req, res) => {
  const schema = z.object({
    branchId: z.string().optional(),
    nodeId: z.string().nullable().optional(),
  });
  try {
    if (req.access?.mode === "guest") {
      res.status(403).json({ error: "Guests stay on their share link’s branch tip" });
      return;
    }
    const { assertNoActiveMerge } = await import("../services/branchMerge.js");
    await assertNoActiveMerge(req.params.id);
    const body = schema.parse(req.body);
    const { checkoutTimeline } = await import("../services/timeline.js");
    // Flush current branch WC before switching
    const { loadTimeline } = await import("../services/timeline.js");
    const cur = await loadTimeline(req.params.id);
    await flushProjectRoom(req.params.id, {
      commit: false,
      branchId: cur.activeBranchId,
    });
    const view = await checkoutTimeline(req.params.id, body);
    // Only reseed the live tip room when returning to an editable tip.
    if (view.canEdit) {
      await reseedProjectRoom(req.params.id, view.activeBranchId);
      notifyProjectTreeChange(req.params.id, { op: "bump" }, view.activeBranchId);
    }
    res.json(view);
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/:id/timeline/merge/start", async (req, res) => {
  const schema = z.object({
    sourceBranchId: z.string().min(1),
    targetBranchId: z.string().optional(),
    commitDirtyTarget: z.boolean().optional(),
    preMergeMessage: z.string().max(200).optional(),
  });
  try {
    if (req.access?.mode === "guest") {
      res.status(403).json({ error: "Only the host can merge branches" });
      return;
    }
    const body = schema.parse(req.body);
    const { loadTimeline } = await import("../services/timeline.js");
    const {
      startBranchMerge,
    } = await import("../services/branchMerge.js");
    const cur = await loadTimeline(req.params.id);
    const targetBranchId = body.targetBranchId ?? cur.activeBranchId;
    await flushProjectRoom(req.params.id, {
      author: await authorFromRequest(req.params.id, req),
      commit: false,
      branchId: targetBranchId,
    });
    const session = await startBranchMerge(req.params.id, {
      sourceBranchId: body.sourceBranchId,
      targetBranchId,
      author: await authorFromRequest(req.params.id, req),
      commitDirtyTarget: body.commitDirtyTarget,
      preMergeMessage: body.preMergeMessage,
    });
    // Disk now has merge state / conflict markers — refresh live collab from disk.
    await clearCollabSnapshot(req.params.id, targetBranchId);
    await reseedProjectRoom(req.params.id, targetBranchId);
    notifyProjectTreeChange(req.params.id, { op: "bump" }, targetBranchId);
    res.status(201).json(session);
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.get("/:id/timeline/merge", async (req, res) => {
  try {
    if (req.access?.mode === "guest") {
      res.status(403).json({ error: "Merging branches is host-only" });
      return;
    }
    const { getBranchMerge } = await import("../services/branchMerge.js");
    const session = await getBranchMerge(req.params.id);
    if (!session) {
      res.status(204).end();
      return;
    }
    res.json(session);
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.get("/:id/timeline/merge/file", async (req, res) => {
  try {
    if (req.access?.mode === "guest") {
      res.status(403).json({ error: "Merging branches is host-only" });
      return;
    }
    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!filePath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    const { getMergeConflictFile } = await import("../services/branchMerge.js");
    res.json(await getMergeConflictFile(req.params.id, filePath));
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/:id/timeline/merge/resolve", async (req, res) => {
  const schema = z.object({
    path: z.string().min(1),
    strategy: z.enum(["ours", "theirs", "manual"]),
    content: z.string().optional(),
  });
  try {
    if (req.access?.mode === "guest") {
      res.status(403).json({ error: "Only the host can merge branches" });
      return;
    }
    const body = schema.parse(req.body);
    const { resolveMergeConflict } = await import("../services/branchMerge.js");
    const session = await resolveMergeConflict(req.params.id, body);
    await clearCollabSnapshot(req.params.id, session.targetBranchId);
    await reseedProjectRoom(req.params.id, session.targetBranchId);
    notifyProjectTreeChange(req.params.id, { op: "bump" }, session.targetBranchId);
    res.json(session);
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/:id/timeline/merge/complete", async (req, res) => {
  const schema = z.object({
    message: z.string().optional(),
  });
  try {
    if (req.access?.mode === "guest") {
      res.status(403).json({ error: "Only the host can merge branches" });
      return;
    }
    const body = schema.parse(req.body ?? {});
    const { completeBranchMerge } = await import("../services/branchMerge.js");
    const result = await completeBranchMerge(req.params.id, {
      message: body.message,
      author: await authorFromRequest(req.params.id, req),
    });
    await clearCollabSnapshot(req.params.id, result.session.targetBranchId);
    await reseedProjectRoom(req.params.id, result.session.targetBranchId);
    notifyProjectTreeChange(req.params.id, { op: "bump" }, result.session.targetBranchId);
    res.json(result);
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/:id/timeline/merge/abort", async (req, res) => {
  try {
    if (req.access?.mode === "guest") {
      res.status(403).json({ error: "Only the host can merge branches" });
      return;
    }
    const { abortBranchMerge } = await import("../services/branchMerge.js");
    const result = await abortBranchMerge(req.params.id);
    await clearCollabSnapshot(req.params.id, result.targetBranchId);
    await reseedProjectRoom(req.params.id, result.targetBranchId);
    notifyProjectTreeChange(req.params.id, { op: "bump" }, result.targetBranchId);
    res.json(result);
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/:id/fs/mkdir", async (req, res) => {
  const schema = z.object({ path: z.string().min(1) });
  try {
    const body = schema.parse(req.body);
    if (rejectGuestProtectedWrite(req, body.path, res)) return;
    const branchId = await resolveBranchIdWithActive(req, req.params.id, { mutate: true });
    const root = await branchRoot(req.params.id, branchId);
    await mkdirPath(req.params.id, body.path, root);
    notifyProjectTreeChange(req.params.id, { op: "mkdir", path: body.path }, branchId);
    const git = await commitAfterChange(req.params.id, `mkdir ${body.path}`, req);
    res.status(201).json({ ok: true, path: body.path, git });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/:id/fs/create", async (req, res) => {
  const schema = z.object({
    path: z.string().min(1),
    content: z.string().optional(),
  });
  try {
    const body = schema.parse(req.body);
    if (rejectGuestProtectedWrite(req, body.path, res)) return;
    const branchId = await resolveBranchIdWithActive(req, req.params.id, { mutate: true });
    const root = await branchRoot(req.params.id, branchId);
    await createEmptyFile(req.params.id, body.path, body.content ?? "", root);
    notifyProjectTreeChange(req.params.id, { op: "create", path: body.path }, branchId);
    const git = await commitAfterChange(req.params.id, `Create ${body.path}`, req);
    res.status(201).json({ ok: true, path: body.path, git });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/:id/fs/rename", async (req, res) => {
  const schema = z.object({
    from: z.string().min(1),
    to: z.string().min(1),
  });
  try {
    const body = schema.parse(req.body);
    if (rejectGuestProtectedWrite(req, body.from, res) || rejectGuestProtectedWrite(req, body.to, res)) return;
    const branchId = await resolveBranchIdWithActive(req, req.params.id, { mutate: true });
    const root = await branchRoot(req.params.id, branchId);
    await renamePath(req.params.id, body.from, body.to, root);
    notifyProjectTreeChange(req.params.id, { op: "rename", from: body.from, to: body.to }, branchId);
    const git = await commitAfterChange(req.params.id, `Rename ${body.from} → ${body.to}`, req);
    res.json({ ok: true, from: body.from, to: body.to, git });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/:id/compile", async (req, res) => {
  const id = req.params.id;
  const stream = req.query.stream === "1" || req.headers.accept?.includes("text/event-stream");
  const at = typeof req.query.at === "string" ? req.query.at.trim() : undefined;
  const branchId = at
    ? undefined
    : await resolveBranchIdWithActive(req, id, { mutate: true }).catch(() => "main");

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
    };

    try {
      send("status", { state: "running" });
      const result = await compileProject(
        id,
        (chunk) => {
          send("log", { chunk });
        },
        { branchId, at },
      );
      send("done", result);
    } catch (err) {
      send("error", { error: err instanceof Error ? err.message : "Compile failed" });
    }
    res.end();
    return;
  }

  try {
    const result = await compileProject(id, undefined, { branchId, at });
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.post("/:id/track-changes", async (req, res) => {
  const id = req.params.id;
  const stream = req.query.stream === "1" || req.headers.accept?.includes("text/event-stream");
  const schema = z.object({
    from: z.string().min(7).max(40).regex(/^[0-9a-f]+$/i),
    to: z.string().min(7).max(40).regex(/^[0-9a-f]+$/i),
  });

  const run = async (onChunk?: (chunk: string) => void) => {
    const body = schema.parse(req.body ?? {});
    const { generateTrackChanges } = await import("../services/trackChanges.js");
    return generateTrackChanges(id, body.from, body.to, onChunk);
  };

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
    };

    try {
      send("status", { state: "running" });
      const result = await run((chunk) => {
        send("log", { chunk });
      });
      send("done", result);
    } catch (err) {
      send("error", { error: publicErrorMessage(err, "Track-changes PDF failed") });
    }
    res.end();
    return;
  }

  try {
    const result = await run();
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.get("/:id/pdf", async (req, res) => {
  try {
    const mode = typeof req.query.mode === "string" ? req.query.mode.trim() : "";
    if (mode === "track-changes") {
      const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
      const to = typeof req.query.to === "string" ? req.query.to.trim() : "";
      if (!from || !to) {
        res.status(400).json({ error: "from and to commit hashes are required" });
        return;
      }
      const { findCachedTrackChangesPdf } = await import("../services/trackChanges.js");
      const cached = await findCachedTrackChangesPdf(req.params.id, from, to);
      if (!cached) {
        res.status(404).json({ error: "Track-changes PDF not generated yet" });
        return;
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Cache-Control", "no-store");
      fs.createReadStream(cached.pdf).pipe(res);
      return;
    }

    const at = typeof req.query.at === "string" ? req.query.at.trim() : undefined;
    let root: string;
    let cfg = await readProjectConfig(req.params.id);
    if (at) {
      const { snapshotRootIfPresent } = await import("../services/timeline.js");
      const snap = snapshotRootIfPresent(req.params.id, at);
      if (!snap) {
        res.status(404).json({ error: "PDF not found. Compile the project first." });
        return;
      }
      root = snap;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(root, "openleaf.json"), "utf8")) as {
          mainFile?: string;
        };
        if (raw.mainFile) cfg = { ...cfg, mainFile: raw.mainFile };
      } catch {
        /* keep tip config */
      }
    } else {
      const branchId = await resolveBranchIdWithActive(req, req.params.id);
      root = await branchRoot(req.params.id, branchId);
    }
    const pdf = pdfPathAbs(req.params.id, cfg.mainFile, root);
    if (!fs.existsSync(pdf)) {
      res.status(404).json({ error: "PDF not found. Compile the project first." });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(pdf).pipe(res);
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.get("/:id/synctex", async (req, res) => {
  try {
    const at = typeof req.query.at === "string" ? req.query.at.trim() : undefined;
    let root: string;
    if (at) {
      const { snapshotRootIfPresent } = await import("../services/timeline.js");
      const snap = snapshotRootIfPresent(req.params.id, at);
      if (!snap) {
        res.status(404).json({ error: "No SyncTeX hit" });
        return;
      }
      root = snap;
    } else {
      const branchId = await resolveBranchIdWithActive(req, req.params.id);
      root = await branchRoot(req.params.id, branchId);
    }
    const direction = String(req.query.direction ?? "reverse");
    if (direction === "forward") {
      const schema = z.object({
        file: z.string().min(1),
        line: z.coerce.number().int().positive(),
        column: z.coerce.number().int().positive().optional(),
      });
      const q = schema.parse(req.query);
      const hit = await forwardSynctex(req.params.id, q.file, q.line, q.column ?? 1, root);
      if (!hit) {
        res.status(404).json({ error: "No SyncTeX hit" });
        return;
      }
      res.json(hit);
      return;
    }

    const schema = z.object({
      page: z.coerce.number().int().positive(),
      x: z.coerce.number(),
      y: z.coerce.number(),
    });
    const q = schema.parse(req.query);
    const hit = await reverseSynctex(req.params.id, q.page, q.x, q.y, root);
    if (!hit) {
      res.status(404).json({ error: "No SyncTeX hit" });
      return;
    }
    res.json(hit);
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});

projectsRouter.get("/:id/download", async (req, res) => {
  const format = String(req.query.format ?? "zip");
  try {
    if (format === "pdf") {
      const at = typeof req.query.at === "string" ? req.query.at.trim() : undefined;
      let cfg = await readProjectConfig(req.params.id);
      let root: string;
      if (at) {
        const { snapshotRootIfPresent } = await import("../services/timeline.js");
        const snap = snapshotRootIfPresent(req.params.id, at);
        if (!snap) {
          res.status(404).json({ error: "PDF not found" });
          return;
        }
        root = snap;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(root, "openleaf.json"), "utf8")) as {
            mainFile?: string;
          };
          if (raw.mainFile) cfg = { ...cfg, mainFile: raw.mainFile };
        } catch {
          /* keep tip config */
        }
      } else {
        const branchId = await resolveBranchIdWithActive(req, req.params.id);
        root = await branchRoot(req.params.id, branchId);
      }
      const pdf = pdfPathAbs(req.params.id, cfg.mainFile, root);
      if (!fs.existsSync(pdf)) {
        res.status(404).json({ error: "PDF not found" });
        return;
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${req.params.id}${path.extname(pdf)}"`,
      );
      fs.createReadStream(pdf).pipe(res);
      return;
    }
    if (format === "track-changes") {
      const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
      const to = typeof req.query.to === "string" ? req.query.to.trim() : "";
      if (!from || !to) {
        res.status(400).json({ error: "from and to commit hashes are required" });
        return;
      }
      const { findCachedTrackChangesPdf } = await import("../services/trackChanges.js");
      const cached = await findCachedTrackChangesPdf(req.params.id, from, to);
      if (!cached) {
        res.status(404).json({ error: "Track-changes PDF not generated yet" });
        return;
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${req.params.id}-changes-${cached.from.shortHash}-${cached.to.shortHash}.pdf"`,
      );
      fs.createReadStream(cached.pdf).pipe(res);
      return;
    }
    if (format === "zip") {
      streamProjectZip(req.params.id, res);
      return;
    }
    res.status(400).json({ error: "format must be pdf, zip, or track-changes" });
  } catch (err) {
    res.status(statusOf(err)).json({ error: publicErrorMessage(err) });
  }
});
