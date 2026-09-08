import { Router } from "express";
import { z } from "zod";
import {
  cloudflaredAvailable,
  getShare,
  hostView,
  listShares,
  revokeGuest,
  startShare,
  stopShare,
} from "../services/share.js";
import { hostOnly } from "../services/shareAuth.js";

function pid(req: { params: unknown }): string {
  return String((req.params as { id?: string }).id ?? "");
}

function statusOf(err: unknown): number {
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return 500;
}

const SettingsSchema = z
  .object({
    expiresAt: z.number().int().optional(),
    /** Convenience alternative to expiresAt. */
    ttlMinutes: z.number().int().positive().optional(),
    maxIps: z.number().int().optional(),
    maxGuests: z.number().int().optional(),
    readOnly: z.boolean().optional(),
    allowCompile: z.boolean().optional(),
    allowDownload: z.boolean().optional(),
    allowHistory: z.boolean().optional(),
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
  const s = getShare(pid(req));
  res.json(s ? { active: s.status === "active" || s.status === "starting", session: hostView(s) } : { active: false });
});

projectShareRouter.post("/", async (req, res) => {
  try {
    const body = SettingsSchema.parse(req.body ?? {});
    const { ttlMinutes, ...rest } = body;
    const expiresAt = rest.expiresAt ?? (ttlMinutes ? Date.now() + ttlMinutes * 60_000 : undefined);
    const s = await startShare(pid(req), { ...rest, ...(expiresAt ? { expiresAt } : {}) });
    res.status(201).json({ active: true, session: hostView(s) });
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed to start share" });
  }
});

projectShareRouter.delete("/", async (req, res) => {
  const stopped = await stopShare(pid(req), "stopped by host");
  res.json({ ok: true, stopped });
});

projectShareRouter.delete("/guests/:guestId", (req, res) => {
  const ok = revokeGuest(pid(req), String(req.params.guestId));
  if (!ok) {
    res.status(404).json({ error: "Guest not found" });
    return;
  }
  res.json({ ok: true });
});
