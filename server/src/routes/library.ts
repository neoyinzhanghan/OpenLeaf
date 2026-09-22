import { Router } from "express";
import { ZodError } from "zod";
import {
  addPaper,
  deleteCollection,
  deletePaper,
  getPaper,
  readCollections,
  reindexLibrary,
  searchPapers,
  updatePaper,
  upsertCollection,
  writeCollections,
} from "../services/library/index.js";
import { importBibtex, importFromLink, importPdf, lookupExternal } from "../services/library/import.js";
import { enrichLibrary, enrichPaper } from "../services/library/enrich.js";
import { checkLibraryIntegrity, checkPaperIntegrity } from "../services/library/integrity.js";
import { CreatePaperInputSchema, PatchPaperInputSchema } from "../services/library/types.js";

export const libraryRouter = Router();

function statusOf(err: unknown): number {
  if (err instanceof ZodError) return 400;
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return 500;
}

function sendError(res: { status: (code: number) => { json: (body: unknown) => void } }, err: unknown): void {
  const message = err instanceof Error ? err.message : "Library error";
  res.status(statusOf(err)).json({ error: message });
}

libraryRouter.get("/", async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
    const collection = typeof req.query.collection === "string" ? req.query.collection : undefined;
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const papers = await searchPapers({ q, tag, collection, limit });
    res.json({ papers });
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.get("/collections", async (_req, res) => {
  try {
    res.json(await readCollections());
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.put("/collections", async (req, res) => {
  try {
    res.json(await writeCollections(req.body));
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.post("/collections", async (req, res) => {
  try {
    const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!id || !name) {
      res.status(400).json({ error: "id and name are required" });
      return;
    }
    res.status(201).json(await upsertCollection(id, name));
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.delete("/collections/:id", async (req, res) => {
  try {
    res.json(await deleteCollection(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.post("/reindex", async (_req, res) => {
  try {
    res.json(await reindexLibrary());
  } catch (err) {
    sendError(res, err);
  }
});

/** Preview external metadata without saving. */
libraryRouter.post("/lookup", async (req, res) => {
  try {
    const paper = await lookupExternal({
      doi: typeof req.body?.doi === "string" ? req.body.doi : undefined,
      arxivId: typeof req.body?.arxivId === "string" ? req.body.arxivId : undefined,
      title: typeof req.body?.title === "string" ? req.body.title : undefined,
      url: typeof req.body?.url === "string" ? req.body.url : undefined,
    });
    if (!paper) {
      res.status(404).json({ error: "No metadata found" });
      return;
    }
    res.json({ paper });
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.post("/import/link", async (req, res) => {
  try {
    const link =
      typeof req.body?.link === "string"
        ? req.body.link
        : typeof req.body?.url === "string"
          ? req.body.url
          : "";
    if (!link.trim()) {
      res.status(400).json({ error: "link is required" });
      return;
    }
    const result = await importFromLink(link, {
      citekey: typeof req.body?.citekey === "string" ? req.body.citekey : undefined,
      dryRun: Boolean(req.body?.dryRun),
    });
    res.status(result.created ? 201 : 200).json(result);
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.post("/import/bibtex", async (req, res) => {
  try {
    const text =
      typeof req.body?.bibtex === "string"
        ? req.body.bibtex
        : typeof req.body?.text === "string"
          ? req.body.text
          : "";
    if (!text.trim()) {
      res.status(400).json({ error: "bibtex text is required" });
      return;
    }
    res.json(await importBibtex(text));
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.post("/import/pdf", async (req, res) => {
  try {
    // Accept base64 body { pdfBase64, filename?, titleHint?, citekey? } to avoid multer dep for now.
    const b64 = typeof req.body?.pdfBase64 === "string" ? req.body.pdfBase64 : "";
    if (!b64) {
      res.status(400).json({ error: "pdfBase64 is required" });
      return;
    }
    const buffer = Buffer.from(b64, "base64");
    if (buffer.length < 5 || buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
      res.status(400).json({ error: "Not a PDF" });
      return;
    }
    const result = await importPdf(buffer, {
      filename: typeof req.body?.filename === "string" ? req.body.filename : undefined,
      titleHint: typeof req.body?.titleHint === "string" ? req.body.titleHint : undefined,
      citekey: typeof req.body?.citekey === "string" ? req.body.citekey : undefined,
    });
    res.status(result.created ? 201 : 200).json(result);
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.post("/integrity/check", async (req, res) => {
  try {
    const citekeys = Array.isArray(req.body?.citekeys)
      ? (req.body.citekeys as unknown[]).filter((c): c is string => typeof c === "string")
      : undefined;
    const results = await checkLibraryIntegrity({
      force: Boolean(req.body?.force),
      citekeys,
    });
    res.json({ results });
  } catch (err) {
    sendError(res, err);
  }
});

/** Pull live Crossref/OpenAlex/arXiv metadata into library records (not BibTeX stubs). */
libraryRouter.post("/enrich", async (req, res) => {
  try {
    const citekeys = Array.isArray(req.body?.citekeys)
      ? (req.body.citekeys as unknown[]).filter((c): c is string => typeof c === "string")
      : undefined;
    const results = await enrichLibrary({
      force: Boolean(req.body?.force),
      citekeys,
      checkIntegrity: req.body?.checkIntegrity !== false,
      delayMs: typeof req.body?.delayMs === "number" ? req.body.delayMs : 200,
    });
    res.json({
      results,
      enriched: results.filter((r) => r.enriched).length,
      total: results.length,
    });
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.post("/:citekey/enrich", async (req, res) => {
  try {
    const result = await enrichPaper(req.params.citekey, {
      force: Boolean(req.body?.force),
      checkIntegrity: req.body?.checkIntegrity !== false,
    });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.post("/:citekey/integrity", async (req, res) => {
  try {
    const result = await checkPaperIntegrity(req.params.citekey, {
      force: Boolean(req.body?.force),
    });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.post("/mcp", async (req, res) => {
  // Host-only (router already behind hostOnly). See libraryMcp.ts security note —
  // do not wire this into Share sessions without the same risk-ack gate.
  try {
    const { handleLibraryMcpHttp } = await import("../services/library/libraryMcp.js");
    const result = await handleLibraryMcpHttp(req.body);
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
    if (result.status === 202) {
      res.status(202).end();
      return;
    }
    res.status(result.status).json(result.body);
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.get("/:citekey", async (req, res) => {
  try {
    res.json(await getPaper(req.params.citekey));
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.post("/", async (req, res) => {
  try {
    const input = CreatePaperInputSchema.parse(req.body);
    const paper = await addPaper(input);
    res.status(201).json(paper);
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.patch("/:citekey", async (req, res) => {
  try {
    const patch = PatchPaperInputSchema.parse(req.body);
    res.json(await updatePaper(req.params.citekey, patch));
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.delete("/:citekey", async (req, res) => {
  try {
    await deletePaper(req.params.citekey);
    res.status(204).end();
  } catch (err) {
    sendError(res, err);
  }
});
