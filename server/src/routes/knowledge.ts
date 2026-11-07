import { Router } from "express";
import { z } from "zod";
import { createKnowledgeItem, listKnowledgeItems } from "../services/knowledge/items.js";
import { parseKnowledge } from "../services/knowledge/parse.js";
import { prepareKnowledgeCompile } from "../services/knowledge/prepareCompile.js";
import { readProjectConfig, resolveProjectPath } from "../services/projectFs.js";
import fs from "node:fs/promises";
import path from "node:path";

export const knowledgeRouter = Router();

function sendError(res: import("express").Response, err: unknown): void {
  const status = typeof err === "object" && err && "status" in err ? Number((err as { status: number }).status) : 500;
  const message = err instanceof Error ? err.message : String(err);
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: message });
}

knowledgeRouter.get("/items", async (_req, res) => {
  try {
    res.json({ items: await listKnowledgeItems() });
  } catch (err) {
    sendError(res, err);
  }
});

knowledgeRouter.post("/items", async (req, res) => {
  try {
    const body = z
      .object({
        title: z.string().min(1).max(200),
        collection: z.string().optional(),
        knowledgeId: z.string().optional(),
      })
      .parse(req.body ?? {});
    const result = await createKnowledgeItem(body);
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
});

knowledgeRouter.get("/graph", async (_req, res) => {
  try {
    // Minimal stub graph — Phase 4 fills in status/why. Enough for tree wiring.
    const { buildKnowledgeGraph } = await import("../services/knowledge/graph.js");
    res.json(await buildKnowledgeGraph());
  } catch (err) {
    sendError(res, err);
  }
});

knowledgeRouter.get("/impact", async (req, res) => {
  try {
    const node = typeof req.query.node === "string" ? req.query.node : "";
    if (!node) {
      res.status(400).json({ error: "node is required" });
      return;
    }
    const { impactOf } = await import("../services/knowledge/graph.js");
    res.json(await impactOf(node));
  } catch (err) {
    sendError(res, err);
  }
});

knowledgeRouter.get("/inbox", async (_req, res) => {
  try {
    const { knowledgeInbox } = await import("../services/knowledge/graph.js");
    res.json(await knowledgeInbox());
  } catch (err) {
    sendError(res, err);
  }
});
