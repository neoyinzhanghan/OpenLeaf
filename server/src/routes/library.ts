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
