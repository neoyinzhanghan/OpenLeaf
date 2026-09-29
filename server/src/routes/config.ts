import { Router } from "express";
import { getPublicConfig, patchConfig } from "../config.js";
import { isLoopbackOwner } from "../services/requestGuard.js";

export const configRouter = Router();

const MACHINE_KEYS = new Set([
  "lanAuth",
  "allowedHosts",
  "access",
  "host",
  "port",
  "projectsRoot",
  "libraryRoot",
]);

/** Settings that let a remote device run commands or read arbitrary paths. */
export function patchChangesMachine(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (MACHINE_KEYS.has(key) || key === "git") return true;
  }
  const latex = record.latex;
  if (latex && typeof latex === "object" && !Array.isArray(latex)) {
    if ("allowProjectLatexmkrc" in latex || "paranoidFileAccess" in latex) return true;
  }
  return false;
}

configRouter.get("/", (_req, res) => {
  res.json(getPublicConfig());
});

configRouter.patch("/", (req, res) => {
  if (patchChangesMachine(req.body) && !isLoopbackOwner(req)) {
    res.status(403).json({
      error: "Only this computer can change that setting",
      code: "LOOPBACK_ONLY",
    });
    return;
  }
  try {
    const next = patchConfig(req.body);
    res.json(next);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid config";
    res.status(400).json({ error: message });
  }
});
