import { Router } from "express";
import { ZodError, z } from "zod";
import { loadConfig } from "../config.js";
import { hostOnly } from "../services/shareAuth.js";
import {
  addSharedNote,
  createLibraryShare,
  getLibraryShareById,
  getLibraryShareByToken,
  libraryShareBundle,
  libraryShareGuestView,
  libraryShareHostView,
  listLibraryShares,
  readSharedPdf,
  stopLibraryShare,
  touchVisitor,
} from "../services/libraryShare.js";
import { addPaper, findByDoi } from "../services/library/index.js";
import { lookupExternal } from "../services/library/import.js";

export const libraryShareRouter = Router();
/** Public guest-facing routes (token in path / body). */
export const librarySharePublicRouter = Router();

function sendError(res: { status: (code: number) => { json: (body: unknown) => void } }, err: unknown): void {
  const status =
    err instanceof ZodError
      ? 400
      : err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number"
        ? (err as { status: number }).status
        : 500;
  const message = err instanceof Error ? err.message : "Library share error";
  res.status(status).json({ error: message });
}

const CreateSchema = z.object({
  citekeys: z.array(z.string()).optional(),
  collectionId: z.string().nullable().optional(),
  settings: z
    .object({
      expiresAt: z.number().nullable().optional(),
      role: z.enum(["viewer", "commenter"]).optional(),
      allowPdf: z.boolean().optional(),
      allowExport: z.boolean().optional(),
      maxGuests: z.number().optional(),
      title: z.string().optional(),
    })
    .optional(),
  riskAck: z.boolean().optional(),
});

libraryShareRouter.get("/", hostOnly, (_req, res) => {
  try {
    const port = loadConfig().port;
    res.json({
      shares: listLibraryShares().map((s) => libraryShareHostView(s, port)),
    });
  } catch (err) {
    sendError(res, err);
  }
});

libraryShareRouter.post("/", hostOnly, async (req, res) => {
  try {
    const body = CreateSchema.parse(req.body);
    if (!body.riskAck) {
      res.status(400).json({
        error: "Confirm the risk acknowledgment before minting a public paper share link",
      });
      return;
    }
    const port = loadConfig().port;
    const { session, inviteUrl } = await createLibraryShare({
      citekeys: body.citekeys,
      collectionId: body.collectionId,
      settings: body.settings,
      port,
    });
    res.status(201).json({ share: libraryShareHostView(session, port), inviteUrl });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * Import papers from an OpenLeaf library-share bundle or invite URL into the host library.
 * (Paperpile "add to my library" / Zotero drag-into-My-Library.)
 */
libraryShareRouter.post("/import", hostOnly, async (req, res) => {
  try {
    const token =
      typeof req.body?.token === "string"
        ? req.body.token
        : typeof req.body?.inviteUrl === "string"
          ? (req.body.inviteUrl.match(/\/lib-share\/([^/?#]+)/)?.[1] ?? "")
          : "";
    const bundle = req.body?.bundle as
      | { papers?: Array<Record<string, unknown>> }
      | undefined;

    let papers: Array<{
      citekey?: string;
      title: string;
      authors?: Array<{ given: string; family: string }>;
      year?: number | null;
      venue?: string;
      doi?: string | null;
      arxivId?: string | null;
      url?: string | null;
      abstract?: string;
      tags?: string[];
    }> = [];

    if (token) {
      const session = getLibraryShareByToken(token);
      if (!session) {
        res.status(404).json({ error: "Share link not found or expired" });
        return;
      }
      if (!session.settings.allowExport) {
        res.status(403).json({ error: "Export / import is disabled for this share" });
        return;
      }
      papers = libraryShareBundle(session).papers;
    } else if (bundle?.papers?.length) {
      papers = bundle.papers as typeof papers;
    } else {
      res.status(400).json({ error: "Provide inviteUrl/token or a share bundle" });
      return;
    }

    const imported: string[] = [];
    const skipped: Array<{ title: string; reason: string; existingCitekey?: string }> = [];

    for (const p of papers) {
      const title = (p.title || "").trim();
      if (!title) continue;
      if (p.doi) {
        const existing = await findByDoi(p.doi);
        if (existing) {
          skipped.push({ title, reason: "doi-exists", existingCitekey: existing.citekey });
          continue;
        }
      }
      try {
        // Prefer live metadata when we have a DOI/arXiv.
        let resolved = null;
        if (p.doi) resolved = await lookupExternal({ doi: p.doi });
        else if (p.arxivId) resolved = await lookupExternal({ arxivId: p.arxivId });
        const paper = await addPaper({
          citekey: p.citekey,
          title: resolved?.title || title,
          authors: resolved?.authors?.length ? resolved.authors : p.authors ?? [],
          year: resolved?.year ?? p.year ?? null,
          venue: resolved?.venue || p.venue || "",
          doi: resolved?.doi ?? p.doi ?? null,
          arxivId: resolved?.arxivId ?? p.arxivId ?? null,
          url: resolved?.url ?? p.url ?? null,
          abstract: resolved?.abstract || p.abstract || "",
          tags: [...new Set([...(p.tags ?? []), "from-share"])],
          source: resolved?.source ?? "manual",
          status: "to-read",
        });
        imported.push(paper.citekey);
      } catch (e) {
        skipped.push({
          title,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }

    res.json({ imported, skipped, count: imported.length });
  } catch (err) {
    sendError(res, err);
  }
});

libraryShareRouter.get("/:id", hostOnly, (req, res) => {
  try {
    const s = getLibraryShareById(req.params.id);
    if (!s) {
      res.status(404).json({ error: "Share not found" });
      return;
    }
    res.json({ share: libraryShareHostView(s, loadConfig().port) });
  } catch (err) {
    sendError(res, err);
  }
});

libraryShareRouter.delete("/:id", hostOnly, async (req, res) => {
  try {
    await stopLibraryShare(req.params.id);
    res.status(204).end();
  } catch (err) {
    sendError(res, err);
  }
});

// —— Public guest API ——
librarySharePublicRouter.get("/:token", (req, res) => {
  try {
    const session = getLibraryShareByToken(req.params.token);
    if (!session) {
      res.status(404).json({ error: "Share not found or expired" });
      return;
    }
    const visitorId = typeof req.query.visitorId === "string" ? req.query.visitorId : undefined;
    const visitor = visitorId ? session.visitors.get(visitorId) ?? null : null;
    if (visitor) {
      visitor.lastSeen = Date.now();
    }
    res.json({ share: libraryShareGuestView(session, visitor ?? null) });
  } catch (err) {
    sendError(res, err);
  }
});

librarySharePublicRouter.post("/:token/join", (req, res) => {
  try {
    const session = getLibraryShareByToken(req.params.token);
    if (!session) {
      res.status(404).json({ error: "Share not found or expired" });
      return;
    }
    const visitor = touchVisitor(session, {
      visitorId: typeof req.body?.visitorId === "string" ? req.body.visitorId : undefined,
      name: typeof req.body?.name === "string" ? req.body.name : undefined,
    });
    res.json({
      visitor: { id: visitor.id, name: visitor.name, color: visitor.color },
      share: libraryShareGuestView(session, visitor),
    });
  } catch (err) {
    sendError(res, err);
  }
});

librarySharePublicRouter.post("/:token/notes", (req, res) => {
  try {
    const session = getLibraryShareByToken(req.params.token);
    if (!session) {
      res.status(404).json({ error: "Share not found or expired" });
      return;
    }
    const visitor = touchVisitor(session, {
      visitorId: typeof req.body?.visitorId === "string" ? req.body.visitorId : undefined,
      name: typeof req.body?.authorName === "string" ? req.body.authorName : undefined,
    });
    const note = addSharedNote(session, {
      citekey: String(req.body?.citekey ?? ""),
      authorName: visitor.name,
      authorColor: visitor.color,
      body: String(req.body?.body ?? ""),
    });
    res.status(201).json({ note, share: libraryShareGuestView(session, visitor) });
  } catch (err) {
    sendError(res, err);
  }
});

librarySharePublicRouter.get("/:token/bundle", (req, res) => {
  try {
    const session = getLibraryShareByToken(req.params.token);
    if (!session) {
      res.status(404).json({ error: "Share not found or expired" });
      return;
    }
    if (!session.settings.allowExport) {
      res.status(403).json({ error: "Export is disabled for this share" });
      return;
    }
    res.json(libraryShareBundle(session));
  } catch (err) {
    sendError(res, err);
  }
});

librarySharePublicRouter.get("/:token/pdf/:citekey", async (req, res) => {
  try {
    const session = getLibraryShareByToken(req.params.token);
    if (!session) {
      res.status(404).json({ error: "Share not found or expired" });
      return;
    }
    const buf = await readSharedPdf(session, req.params.citekey);
    if (!buf) {
      res.status(404).json({ error: "PDF not available" });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${req.params.citekey}.pdf"`);
    res.send(buf);
  } catch (err) {
    sendError(res, err);
  }
});
