import { Router } from "express";

/**
 * Legacy global identities endpoint — collab users are per-project now.
 * Kept so old clients get a clear error instead of empty/wrong data.
 */
export const identitiesRouter = Router();

identitiesRouter.get("/", (_req, res) => {
  res.status(410).json({
    error: "Identities are project-specific. Use GET /api/projects/:id/identities",
  });
});
