import { Router } from "express";
import { getPublicConfig, patchConfig } from "../config.js";

export const configRouter = Router();

configRouter.get("/", (_req, res) => {
  res.json(getPublicConfig());
});

configRouter.patch("/", (req, res) => {
  try {
    const next = patchConfig(req.body);
    res.json(next);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid config";
    res.status(400).json({ error: message });
  }
});
