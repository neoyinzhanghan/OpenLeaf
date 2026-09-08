import { Router } from "express";
import { z } from "zod";
import { getProject } from "../services/projectFs.js";
import { getShareByHost, guestLogin, guestLogout, guestView, isExpired, verifyLinkToken } from "../services/share.js";
import {
  clearCookieHeader,
  clientIp,
  cookieHeader,
  isTunnelRequest,
  LINK_COOKIE,
  linkCookieHeader,
  parseCookies,
  resolveGuest,
} from "../services/shareAuth.js";

function statusOf(err: unknown): number {
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return 500;
}

/**
 * Mounted at /api/guest. Open to unauthenticated tunnel traffic so guests can
 * discover the share and sign in. On a host (local) request `me` simply says so.
 */
export const guestRouter = Router();

guestRouter.get("/me", async (req, res) => {
  if (!isTunnelRequest(req)) {
    res.json({ mode: "host" });
    return;
  }
  const r = resolveGuest(req);
  if (r.reason === "no-session") {
    res.json({ mode: "guest", active: false, reason: "no-session" });
    return;
  }
  if (r.reason === "expired") {
    res.json({ mode: "guest", active: false, reason: "expired" });
    return;
  }
  let projectName = r.session.projectId;
  try {
    projectName = (await getProject(r.session.projectId)).name;
  } catch {
    /* fall back to id */
  }
  if (r.reason === "unauthenticated") {
    res.json({
      mode: "guest",
      active: true,
      authenticated: false,
      linkOk: verifyLinkToken(r.session, parseCookies(req.headers.cookie)[LINK_COOKIE]),
      share: { ...guestView(r.session), projectName },
    });
    return;
  }
  res.json({
    mode: "guest",
    active: true,
    authenticated: true,
    share: { ...guestView(r.session), projectName },
    guest: { id: r.guest.id, name: r.guest.name, color: r.guest.color },
  });
});

guestRouter.post("/login", (req, res) => {
  if (!isTunnelRequest(req)) {
    res.status(400).json({ error: "Guest sign-in is only available through a share link" });
    return;
  }
  const schema = z.object({
    username: z.string().min(1).max(80),
    password: z.string().min(1).max(200),
    displayName: z.string().min(1).max(60),
  });
  try {
    const body = schema.parse(req.body);
    const r = resolveGuest(req);
    if (r.reason === "no-session") {
      res.status(404).json({ error: "This share link is no longer active" });
      return;
    }
    if (r.reason === "expired") {
      res.status(410).json({ error: "This share link has expired" });
      return;
    }
    if (!verifyLinkToken(r.session, parseCookies(req.headers.cookie)[LINK_COOKIE])) {
      res.status(403).json({ error: "Open the complete invitation link the host sent you before signing in" });
      return;
    }
    const { guest, token } = guestLogin(r.session, body, clientIp(req));
    res.setHeader("Set-Cookie", cookieHeader(token, r.session.settings.expiresAt));
    res.json({
      ok: true,
      guest: { id: guest.id, name: guest.name, color: guest.color },
      share: guestView(r.session),
    });
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Sign-in failed" });
  }
});

guestRouter.post("/logout", (req, res) => {
  const r = resolveGuest(req);
  if (r.reason === "ok") guestLogout(r.session, r.guest.id);
  res.setHeader("Set-Cookie", clearCookieHeader());
  res.json({ ok: true });
});

/**
 * Mounted at /join (tunnel traffic). Validates the themed invitation token,
 * remembers it in a cookie and lands the guest on the project page, where
 * the SPA shows the sign-in form.
 */
export const joinRouter = Router();

joinRouter.get("/:token", (req, res) => {
  if (!isTunnelRequest(req)) {
    res.redirect(302, "/");
    return;
  }
  const session = getShareByHost(req.headers.host);
  const token = String(req.params.token ?? "");
  if (!session || session.status !== "active" || isExpired(session) || !verifyLinkToken(session, token)) {
    // Wrong or stale token: land on the SPA, which reports the link as invalid.
    res.setHeader("Set-Cookie", `${LINK_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`);
    res.redirect(302, "/");
    return;
  }
  res.setHeader("Set-Cookie", linkCookieHeader(token, session.settings.expiresAt));
  res.redirect(302, `/p/${encodeURIComponent(session.projectId)}`);
});
