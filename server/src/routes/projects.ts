import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { compileProject } from "../services/compiler.js";
import {
  clearCollabSnapshot,
  flushProjectRoom,
  getOrCreateRoom,
  notifyProjectTreeChange,
  reseedProjectRoom,
} from "../services/collab/room.js";
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
  listProjects,
  mkdirPath,
  pdfPathAbs,
  readFile,
  readProjectConfig,
  renamePath,
  writeFile,
  writeProjectConfig,
} from "../services/projectFs.js";
import { forwardSynctex, reverseSynctex } from "../services/synctex.js";
import { streamProjectZip } from "../services/zip.js";
import { IdentitySchema } from "../config.js";
import type { Access } from "../services/shareAuth.js";
import { projectShareRouter } from "./share.js";

export const projectsRouter = Router();
const filesRouter = Router({ mergeParams: true });
projectsRouter.use("/:id/share", projectShareRouter);

function statusOf(err: unknown): number {
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return 500;
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
  id: string,
  message: string,
  req: { body?: unknown; query?: unknown; headers: Record<string, unknown> },
) {
  return autoCommitProject(id, { message, author: await authorFromRequest(id, req) });
}

projectsRouter.get("/", async (_req, res) => {
  try {
    res.json(await listProjects());
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
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
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

projectsRouter.get("/:id", async (req, res) => {
  try {
    res.json(await getProject(req.params.id));
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

projectsRouter.get("/:id/tree", async (req, res) => {
  try {
    res.json(await getTree(req.params.id));
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
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
    const file = await readFile(id, rel, { forceText });
    res.json({ path: rel, ...file });
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
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
    await writeFile(id, rel, body.content, body.encoding ?? "utf8");
    if ((body.encoding ?? "utf8") === "utf8") {
      notifyProjectTreeChange(id, { op: "write", path: rel });
    }
    const git = await commitAfterChange(id, `Save ${rel}`, req);
    res.json({ ok: true, path: rel, git });
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
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
    await deletePath(id, rel);
    notifyProjectTreeChange(id, { op: "delete", path: rel });
    const git = await commitAfterChange(id, `Delete ${rel}`, req);
    res.json({ ok: true, path: rel, git });
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

projectsRouter.use("/:id/files", filesRouter);

projectsRouter.get("/:id/identities", async (req, res) => {
  try {
    res.json(await getProjectIdentities(req.params.id));
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
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
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

projectsRouter.post("/:id/collab/flush", async (req, res) => {
  const schema = z
    .object({
      identityId: z.string().optional(),
      message: z.string().optional(),
    })
    .optional();
  try {
    const body = schema.parse(req.body ?? {});
    const git = await flushProjectRoom(req.params.id, {
      author: await authorFromRequest(req.params.id, req),
      message: body?.message ?? "Save & sync",
      commit: true,
    });
    res.json({ ok: true, git });
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

projectsRouter.post("/:id/collab/ensure", async (req, res) => {
  const schema = z.object({ path: z.string().min(1) });
  try {
    const body = schema.parse(req.body);
    const room = await getOrCreateRoom(req.params.id);
    await room.ensureFile(body.path);
    res.json({ ok: true, path: body.path });
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

projectsRouter.get("/:id/history", async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const commits = await listProjectCommits(req.params.id, Number.isFinite(limit) ? limit : 50);
    res.json(commits);
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
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
      commit: true,
    });
    await restoreProjectCommit(req.params.id, body.hash);
    // Stale CRDT snapshot must not undo the restore on next room open
    await clearCollabSnapshot(req.params.id);
    await reseedProjectRoom(req.params.id);
    notifyProjectTreeChange(req.params.id, { op: "bump" });
    const git = await autoCommitProject(req.params.id, {
      author,
      message: `Restore snapshot ${body.hash.slice(0, 7)}`,
    });
    res.json({ ok: true, git });
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

projectsRouter.post("/:id/fs/mkdir", async (req, res) => {
  const schema = z.object({ path: z.string().min(1) });
  try {
    const body = schema.parse(req.body);
    await mkdirPath(req.params.id, body.path);
    notifyProjectTreeChange(req.params.id, { op: "mkdir", path: body.path });
    const git = await commitAfterChange(req.params.id, `mkdir ${body.path}`, req);
    res.status(201).json({ ok: true, path: body.path, git });
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

projectsRouter.post("/:id/fs/create", async (req, res) => {
  const schema = z.object({
    path: z.string().min(1),
    content: z.string().optional(),
  });
  try {
    const body = schema.parse(req.body);
    await createEmptyFile(req.params.id, body.path, body.content ?? "");
    notifyProjectTreeChange(req.params.id, { op: "create", path: body.path });
    const git = await commitAfterChange(req.params.id, `Create ${body.path}`, req);
    res.status(201).json({ ok: true, path: body.path, git });
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

projectsRouter.post("/:id/fs/rename", async (req, res) => {
  const schema = z.object({
    from: z.string().min(1),
    to: z.string().min(1),
  });
  try {
    const body = schema.parse(req.body);
    await renamePath(req.params.id, body.from, body.to);
    notifyProjectTreeChange(req.params.id, { op: "rename", from: body.from, to: body.to });
    const git = await commitAfterChange(req.params.id, `Rename ${body.from} → ${body.to}`, req);
    res.json({ ok: true, from: body.from, to: body.to, git });
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

projectsRouter.post("/:id/compile", async (req, res) => {
  const id = req.params.id;
  const stream = req.query.stream === "1" || req.headers.accept?.includes("text/event-stream");

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      send("status", { state: "running" });
      const result = await compileProject(id, (chunk) => {
        send("log", { chunk });
      });
      send("done", result);
    } catch (err) {
      send("error", { error: err instanceof Error ? err.message : "Compile failed" });
    }
    res.end();
    return;
  }

  try {
    const result = await compileProject(id);
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

projectsRouter.get("/:id/pdf", async (req, res) => {
  try {
    const cfg = await readProjectConfig(req.params.id);
    const pdf = pdfPathAbs(req.params.id, cfg.mainFile);
    if (!fs.existsSync(pdf)) {
      res.status(404).json({ error: "PDF not found. Compile the project first." });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(pdf).pipe(res);
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

projectsRouter.get("/:id/synctex", async (req, res) => {
  try {
    const direction = String(req.query.direction ?? "reverse");
    if (direction === "forward") {
      const schema = z.object({
        file: z.string().min(1),
        line: z.coerce.number().int().positive(),
        column: z.coerce.number().int().positive().optional(),
      });
      const q = schema.parse(req.query);
      const hit = await forwardSynctex(req.params.id, q.file, q.line, q.column ?? 1);
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
    const hit = await reverseSynctex(req.params.id, q.page, q.x, q.y);
    if (!hit) {
      res.status(404).json({ error: "No SyncTeX hit" });
      return;
    }
    res.json(hit);
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

projectsRouter.get("/:id/download", async (req, res) => {
  const format = String(req.query.format ?? "zip");
  try {
    if (format === "pdf") {
      const cfg = await readProjectConfig(req.params.id);
      const pdf = pdfPathAbs(req.params.id, cfg.mainFile);
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
    if (format === "zip") {
      streamProjectZip(req.params.id, res);
      return;
    }
    res.status(400).json({ error: "format must be pdf or zip" });
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});
