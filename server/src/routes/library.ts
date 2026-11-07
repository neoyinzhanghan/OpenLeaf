import { Router } from "express";
import fs from "node:fs";
import { z, ZodError } from "zod";
import {
  addPaper,
  bulkPatchPapers,
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
import { exportLibraryPapers } from "../services/library/cite.js";
import {
  addAnnotation,
  CreateAnnotationInputSchema,
  deleteAnnotation,
  listAnnotations,
  PatchAnnotationInputSchema,
  updateAnnotation,
} from "../services/library/annotations.js";
import {
  CreateFactInputSchema,
  createFact,
  previewFactKeyRename,
  renameFactKey,
  deleteFact,
  FactStatusSchema,
  FactTypeSchema,
  getFactsCapability,
  listAllFacts,
  listFacts,
  PatchFactInputSchema,
  updateFact,
} from "../services/library/facts.js";
import { fetchAndAttachPdf, getPdfSourceHint, pdfSourceHintSync } from "../services/library/pdfFetch.js";
import { attachOrReplacePaperPdf, pdfReplacePreview } from "../services/library/attachPdf.js";
import { attachmentPath, paperDir, recordPath } from "../services/library/paths.js";
import { addWebSource } from "../services/library/webSource.js";
import { snapshotTxtPath } from "../services/library/sourceText.js";
import { formatAbsolutePath, parsePathOs } from "../services/hostPath.js";
import {
  BulkLibraryPatchSchema,
  CreatePaperInputSchema,
  PatchPaperInputSchema,
} from "../services/library/types.js";

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
  const body: Record<string, unknown> = { error: message };
  if (err && typeof err === "object") {
    for (const key of ["code", "taggedFactCount", "totalFacts"] as const) {
      if (key in err) body[key] = (err as Record<string, unknown>)[key];
    }
  }
  res.status(statusOf(err)).json(body);
}

libraryRouter.get("/", async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
    const tagsRaw = typeof req.query.tags === "string" ? req.query.tags : undefined;
    const tags = tagsRaw
      ? tagsRaw
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;
    const collection = typeof req.query.collection === "string" ? req.query.collection : undefined;
    const starred =
      req.query.starred === "1" || req.query.starred === "true"
        ? true
        : req.query.starred === "0" || req.query.starred === "false"
          ? false
          : undefined;
    const status =
      typeof req.query.status === "string" &&
      ["unread", "to-read", "reading", "read", "archived"].includes(req.query.status)
        ? (req.query.status as "unread" | "to-read" | "reading" | "read" | "archived")
        : undefined;
    const sort =
      typeof req.query.sort === "string" &&
      ["added", "title", "year", "rating", "starred", "status"].includes(req.query.sort)
        ? (req.query.sort as "added" | "title" | "year" | "rating" | "starred" | "status")
        : undefined;
    // A non-numeric ?limit= (e.g. "abc") used to become NaN here and flow
    // into searchPapers's Math.min/Math.max clamp, which stays NaN and
    // makes Array.prototype.slice(0, NaN) return zero results — a silent
    // "empty library" instead of a clear error or an ignored bad value.
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const limit = rawLimit != null && Number.isFinite(rawLimit) ? rawLimit : undefined;
    const papers = await searchPapers({ q, tag, tags, collection, starred, status, sort, limit });
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

/** Bulk organizational edits (star, status, tags, collections). */
libraryRouter.post("/bulk", async (req, res) => {
  try {
    const body = BulkLibraryPatchSchema.parse(req.body);
    const papers = await bulkPatchPapers(body);
    res.json({ papers, count: papers.length });
  } catch (err) {
    sendError(res, err);
  }
});

/** Export selected papers or a collection as BibTeX or RIS. */
libraryRouter.post("/export", async (req, res) => {
  try {
    const format =
      req.body?.format === "ris" || req.query.format === "ris" ? "ris" : "bibtex";
    const citekeys = Array.isArray(req.body?.citekeys)
      ? (req.body.citekeys as unknown[]).filter((c): c is string => typeof c === "string")
      : undefined;
    const collection =
      typeof req.body?.collection === "string"
        ? req.body.collection
        : typeof req.query.collection === "string"
          ? req.query.collection
          : undefined;
    const result = await exportLibraryPapers({ citekeys, collection, format });
    const mime = format === "ris" ? "application/x-research-info-systems" : "application/x-bibtex";
    if (req.body?.download === true || req.query.download === "1") {
      res.setHeader("Content-Type", `${mime}; charset=utf-8`);
      res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
      res.send(result.text);
      return;
    }
    res.json(result);
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

/** Save a web page as a library source (snapshot.txt only ever served as text). */
libraryRouter.post("/import/web", async (req, res) => {
  try {
    const url =
      typeof req.body?.url === "string"
        ? req.body.url
        : typeof req.body?.link === "string"
          ? req.body.link
          : "";
    if (!url.trim()) {
      res.status(400).json({ error: "url is required" });
      return;
    }
    const collections = Array.isArray(req.body?.collections)
      ? req.body.collections.filter((c: unknown): c is string => typeof c === "string")
      : undefined;
    const result = await addWebSource({
      url: url.trim(),
      title: typeof req.body?.title === "string" ? req.body.title : undefined,
      collections,
      notes: typeof req.body?.notes === "string" ? req.body.notes : undefined,
    });
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
});

/** Readable web snapshot — always text/plain (never serve snapshot.html). */
libraryRouter.get("/:citekey/snapshot.txt", async (req, res) => {
  try {
    const file = snapshotTxtPath(req.params.citekey);
    if (!fs.existsSync(file)) {
      res.status(404).json({ error: "No web snapshot for this source" });
      return;
    }
    res.type("text/plain; charset=utf-8");
    res.send(await fs.promises.readFile(file, "utf8"));
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

libraryRouter.get("/:citekey/host-path", async (req, res) => {
  try {
    const paper = await getPaper(req.params.citekey);
    const kind = typeof req.query.kind === "string" ? req.query.kind : "folder";
    let abs: string;
    if (kind === "pdf") {
      if (!paper.attachment || !fs.existsSync(attachmentPath(paper.citekey))) {
        res.status(404).json({ error: "No PDF attachment" });
        return;
      }
      abs = attachmentPath(paper.citekey);
    } else if (kind === "record") {
      abs = recordPath(paper.citekey);
    } else if (kind === "folder") {
      abs = paperDir(paper.citekey);
    } else {
      res.status(400).json({ error: "kind must be pdf, folder, or record" });
      return;
    }
    res.json({ path: await formatAbsolutePath(abs, parsePathOs(req.query.os)) });
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.get("/:citekey/pdf", async (req, res) => {
  try {
    const paper = await getPaper(req.params.citekey);
    if (!paper.attachment) {
      res.status(404).json({ error: "No PDF attachment" });
      return;
    }
    const file = attachmentPath(paper.citekey);
    if (!fs.existsSync(file)) {
      res.status(404).json({ error: "PDF file missing on disk" });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${paper.citekey}.pdf"`,
    );
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.get("/:citekey/pdf-source", async (req, res) => {
  try {
    const probe = req.query.probe === "1" || req.query.probe === "true";
    if (probe) {
      res.json(await getPdfSourceHint(req.params.citekey));
      return;
    }
    const paper = await getPaper(req.params.citekey);
    res.json(pdfSourceHintSync(paper));
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.post("/:citekey/fetch-pdf", async (req, res) => {
  try {
    const result = await fetchAndAttachPdf(req.params.citekey);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.get("/:citekey/pdf-replace-preview", async (req, res) => {
  try {
    res.json(await pdfReplacePreview(req.params.citekey));
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.post("/:citekey/pdf", async (req, res) => {
  try {
    const pdfBase64 = typeof req.body?.pdfBase64 === "string" ? req.body.pdfBase64 : "";
    if (!pdfBase64) {
      res.status(400).json({ error: "pdfBase64 is required" });
      return;
    }
    const replace =
      req.body?.replace === true || req.query.replace === "1" || req.query.replace === "true";
    let buffer: Buffer;
    try {
      buffer = Buffer.from(pdfBase64, "base64");
    } catch {
      res.status(400).json({ error: "Invalid pdfBase64" });
      return;
    }
    const result = await attachOrReplacePaperPdf(req.params.citekey, buffer, { replace });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.get("/facts", async (req, res) => {
  try {
    const citekey = typeof req.query.citekey === "string" ? req.query.citekey : undefined;
    const typeRaw = typeof req.query.type === "string" ? req.query.type : undefined;
    const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const type = typeRaw ? FactTypeSchema.parse(typeRaw) : undefined;
    const status = statusRaw ? FactStatusSchema.parse(statusRaw) : undefined;
    const facts = await listAllFacts({ citekey, type, status, q });
    res.json({ facts });
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.get("/:citekey/facts/capability", async (req, res) => {
  try {
    const capability = await getFactsCapability(req.params.citekey);
    res.json({ capability });
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.get("/:citekey/facts", async (req, res) => {
  try {
    const facts = await listFacts(req.params.citekey);
    res.json({ facts });
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.post("/:citekey/facts", async (req, res) => {
  try {
    const input = CreateFactInputSchema.parse(req.body ?? {});
    const fact = await createFact(req.params.citekey, input);
    res.status(201).json({ fact });
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.patch("/:citekey/facts/:id", async (req, res) => {
  try {
    const patch = PatchFactInputSchema.parse(req.body ?? {});
    const fact = await updateFact(req.params.citekey, req.params.id, patch);
    res.json({ fact });
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.post("/:citekey/facts/:id/rename-key", async (req, res) => {
  try {
    const body = z
      .object({
        key: z.string().min(2).max(64),
        preview: z.boolean().optional(),
        rewriteReferences: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    if (body.preview) {
      const preview = await previewFactKeyRename(req.params.citekey, req.params.id, body.key);
      res.json(preview);
      return;
    }
    const result = await renameFactKey(req.params.citekey, req.params.id, body.key, {
      rewriteReferences: body.rewriteReferences,
    });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.delete("/:citekey/facts/:id", async (req, res) => {
  try {
    await deleteFact(req.params.citekey, req.params.id);
    res.status(204).end();
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.get("/:citekey/annotations", async (req, res) => {
  try {
    const annotations = await listAnnotations(req.params.citekey);
    res.json({ annotations });
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.post("/:citekey/annotations", async (req, res) => {
  try {
    const input = CreateAnnotationInputSchema.parse(req.body ?? {});
    const annotation = await addAnnotation(req.params.citekey, input);
    res.status(201).json({ annotation });
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.patch("/:citekey/annotations/:id", async (req, res) => {
  try {
    const patch = PatchAnnotationInputSchema.parse(req.body ?? {});
    const annotation = await updateAnnotation(req.params.citekey, req.params.id, patch);
    res.json({ annotation });
  } catch (err) {
    sendError(res, err);
  }
});

libraryRouter.delete("/:citekey/annotations/:id", async (req, res) => {
  try {
    await deleteAnnotation(req.params.citekey, req.params.id);
    res.status(204).end();
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
