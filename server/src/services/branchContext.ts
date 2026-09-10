import type { Request } from "express";
import { ensureBranchRoot, loadTimeline } from "./timeline.js";

/**
 * Resolve which timeline branch a request should operate on.
 *
 * - Host: query/body `branchId`, else host's active timeline branch, else main.
 * - Guest: may *observe* any project branch via query/body (read paths).
 *   Mutating paths should pass `mutate: true` so the share-bound branch wins.
 */
export function resolveBranchId(
  req: Request,
  opts?: { bodyBranchId?: string; queryBranchId?: string; mutate?: boolean },
): string {
  const fromQuery =
    opts?.queryBranchId ??
    (typeof req.query.branchId === "string" ? req.query.branchId : undefined);
  const fromBody = opts?.bodyBranchId;
  const requested = fromBody || fromQuery;

  if (req.access?.mode === "guest") {
    const bound = req.access.session.branchId || "main";
    if (opts?.mutate) return bound;
    return requested || bound;
  }

  return requested || "main";
}

/** Prefer host active branch when the caller omitted branchId (host-only). */
export async function resolveBranchIdWithActive(
  req: Request,
  projectId: string,
  opts?: { bodyBranchId?: string; queryBranchId?: string; mutate?: boolean },
): Promise<string> {
  const explicit =
    opts?.bodyBranchId ||
    opts?.queryBranchId ||
    (typeof req.query.branchId === "string" ? req.query.branchId : undefined);

  if (req.access?.mode === "guest") {
    const bound = req.access.session.branchId || "main";
    if (opts?.mutate) return bound;
    return explicit || bound;
  }

  if (explicit) return explicit;
  try {
    const state = await loadTimeline(projectId);
    return state.activeBranchId || "main";
  } catch {
    return "main";
  }
}

export async function branchRoot(projectId: string, branchId: string): Promise<string> {
  return ensureBranchRoot(projectId, branchId);
}
