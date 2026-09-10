import { Router } from "express";
import { z, ZodError } from "zod";
import {
  cloudflaredAvailable,
  getShare,
  hostView,
  listShares,
  listSharesForProject,
  revokeGuest,
  startShare,
  stopShare,
  updateShare,
} from "../services/share.js";
import { hostOnly } from "../services/shareAuth.js";
import { getBranch, loadTimeline } from "../services/timeline.js";

function pid(req: { params: unknown }): string {
  return String((req.params as { id?: string }).id ?? "");
}

function statusOf(err: unknown): number {
  if (err instanceof ZodError) return 400;
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return 500;
}

const SettingsSchema = z
  .object({
    branchId: z.string().min(1),
    allowMainShare: z.boolean().optional(),
    expiresAt: z.number().int().nullable().optional(),
    ttlMinutes: z.number().int().positive().optional(),
    indefinite: z.boolean().optional(),
    maxIps: z.number().int().optional(),
    maxGuests: z.number().int().optional(),
    readOnly: z.boolean().optional(),
    allowCompile: z.boolean().optional(),
    allowDownload: z.boolean().optional(),
    allowHistory: z.boolean().optional(),
  })
  .strict();

const UpdateSchema = z
  .object({
    branchId: z.string().min(1).optional(),
    expiresAt: z.number().int().nullable().optional(),
    extendMinutes: z.number().int().optional(),
    indefinite: z.boolean().optional(),
    maxIps: z.number().int().optional(),
    maxGuests: z.number().int().optional(),
  })
  .strict();

/** Mounted at /api/share (host only): overview of every live session. */
export const shareRouter = Router();
shareRouter.use(hostOnly);

shareRouter.get("/", (_req, res) => {
  res.json({
    cloudflared: cloudflaredAvailable(),
    sessions: listShares().map(hostView),
  });
});

/** Mounted at /api/projects/:id/share (host only). */
export const projectShareRouter = Router({ mergeParams: true });
projectShareRouter.use(hostOnly);

projectShareRouter.get("/", (req, res) => {
  const branchId = typeof req.query.branchId === "string" ? req.query.branchId : undefined;
  const sessions = listSharesForProject(pid(req))
    .filter((s) => s.status === "active" || s.status === "starting")
    .map(hostView);
  if (branchId) {
    const s = getShare(pid(req), branchId);
    res.json({
      active: Boolean(s && (s.status === "active" || s.status === "starting")),
      session: s && (s.status === "active" || s.status === "starting") ? hostView(s) : undefined,
      sessions,
    });
    return;
  }
  res.json({
    active: sessions.length > 0,
    session: sessions[0],
    sessions,
  });
});

projectShareRouter.post("/", async (req, res) => {
  try {
    const body = SettingsSchema.parse(req.body ?? {});
    const timeline = await loadTimeline(pid(req));
    const branch = getBranch(timeline, body.branchId);
    const { ttlMinutes, indefinite, branchId, allowMainShare, ...rest } = body;
    const expiresAt =
      indefinite || rest.expiresAt === null
        ? null
        : (rest.expiresAt ?? (ttlMinutes ? Date.now() + ttlMinutes * 60_000 : undefined));
    const s = await startShare(pid(req), {
      ...rest,
      branchId,
      branchName: branch.name,
      // Non-sacred branches don't need the main warning; sacred main requires explicit flag.
      allowMainShare: branch.sacred ? Boolean(allowMainShare) : true,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    });
    res.status(201).json({ active: true, session: hostView(s), sessions: listSharesForProject(pid(req)).map(hostView) });
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed to start share" });
  }
});

/** Live adjustments: extend the deadline, raise/lower device and guest caps. */
projectShareRouter.patch("/", (req, res) => {
  try {
    const body = UpdateSchema.parse(req.body ?? {});
    const current = getShare(pid(req), body.branchId);
    if (!current) {
      res.status(404).json({ error: "No active share session for this project" });
      return;
    }
    const { extendMinutes, indefinite, branchId, ...rest } = body;
    let expiresAt: number | null | undefined = rest.expiresAt;
    if (indefinite) expiresAt = null;
    else if (extendMinutes !== undefined) {
      const base = current.settings.expiresAt ?? Date.now();
      expiresAt = base + extendMinutes * 60_000;
    }
    const s = updateShare(
      pid(req),
      {
        ...(rest.maxIps !== undefined ? { maxIps: rest.maxIps } : {}),
        ...(rest.maxGuests !== undefined ? { maxGuests: rest.maxGuests } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      },
      branchId ?? current.branchId,
    );
    res.json({ active: true, session: hostView(s), sessions: listSharesForProject(pid(req)).map(hostView) });
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed to update share" });
  }
});

projectShareRouter.delete("/", async (req, res) => {
  const branchId = typeof req.query.branchId === "string" ? req.query.branchId : undefined;
  const stopped = await stopShare(pid(req), "stopped by host", branchId);
  res.json({ ok: true, stopped });
});

projectShareRouter.delete("/guests/:guestId", (req, res) => {
  const branchId = typeof req.query.branchId === "string" ? req.query.branchId : undefined;
  const ok = revokeGuest(pid(req), String(req.params.guestId), branchId);
  if (!ok) {
    res.status(404).json({ error: "Guest not found" });
    return;
  }
  res.json({ ok: true });
});
