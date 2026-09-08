import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { getShareByHost, isExpired, verifyGuestToken, type Guest, type ShareSession } from "./share.js";

/**
 * Splits traffic into two worlds:
 *   - host: anything that reached the server directly (localhost / LAN),
 *     i.e. the machine owner. Unchanged, full access.
 *   - guest: anything that arrived through a Cloudflare tunnel. Must present a
 *     valid session cookie for the share whose hostname it used, and is then
 *     confined to that share's project and permissions.
 */

export type Access =
  | { mode: "host" }
  | { mode: "guest"; session: ShareSession; guest: Guest };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      access?: Access;
    }
  }
}

export const GUEST_COOKIE = "openleaf_share";
/** Set by GET /join/:token; proves the guest opened the full invitation link. */
export const LINK_COOKIE = "openleaf_link";

export function isTunnelRequest(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? "").toLowerCase();
  if (host.endsWith(".trycloudflare.com") || /\.trycloudflare\.com(:\d+)?$/.test(host)) return true;
  if (typeof req.headers["cf-connecting-ip"] === "string") return true;
  if (getShareByHost(req.headers.host)) return true;
  return false;
}

export function clientIp(req: IncomingMessage): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf) return cf;
  return req.socket?.remoteAddress ?? "unknown";
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export type GuestResolution =
  | { session: undefined; guest: null; reason: "no-session" }
  | { session: ShareSession; guest: null; reason: "expired" }
  | { session: ShareSession; guest: null; reason: "unauthenticated" }
  | { session: ShareSession; guest: Guest; reason: "ok" };

/** Shared by the HTTP gate and the WebSocket upgrade handler. */
export function resolveGuest(req: IncomingMessage): GuestResolution {
  const session = getShareByHost(req.headers.host);
  if (!session || session.status !== "active") return { session: undefined, guest: null, reason: "no-session" };
  if (isExpired(session)) return { session, guest: null, reason: "expired" };
  const token = parseCookies(req.headers.cookie)[GUEST_COOKIE];
  const guest = verifyGuestToken(session, token, clientIp(req));
  if (!guest) return { session, guest: null, reason: "unauthenticated" };
  return { session, guest, reason: "ok" };
}

/**
 * Cookies outlive the session's current deadline on purpose: the host may
 * extend it live, and validity is enforced server-side anyway (the HMAC secret
 * rotates when the session ends).
 */
const COOKIE_HORIZON_MS = 31 * 24 * 3600_000;

export function cookieHeader(token: string, _expiresAt: number): string {
  const exp = new Date(Date.now() + COOKIE_HORIZON_MS).toUTCString();
  return `${GUEST_COOKIE}=${encodeURIComponent(token)}; Path=/; Expires=${exp}; HttpOnly; Secure; SameSite=Lax`;
}

export function linkCookieHeader(token: string, _expiresAt: number): string {
  const exp = new Date(Date.now() + COOKIE_HORIZON_MS).toUTCString();
  return `${LINK_COOKIE}=${encodeURIComponent(token)}; Path=/; Expires=${exp}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookieHeader(): string {
  return `${GUEST_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
}

/** Route-level permissions for an authenticated guest. Returns an error string or null when allowed. */
function guestRouteDenial(req: Request, session: ShareSession): { status: number; error: string } | null {
  const p = req.path;
  const m = req.method.toUpperCase();
  const s = session.settings;

  const projPrefix = `/api/projects/${encodeURIComponent(session.projectId)}`;
  if (!p.startsWith(projPrefix + "/") && p !== projPrefix) {
    return { status: 403, error: "This link only grants access to one project" };
  }
  const sub = p.slice(projPrefix.length); // "" or "/tree", "/files/...", ...

  if (sub === "") return m === "GET" ? null : { status: 403, error: "Not allowed for guests" };
  if (sub.startsWith("/share")) return { status: 403, error: "Sharing controls are host-only" };
  if (sub.startsWith("/identities")) {
    return m === "GET" ? null : { status: 403, error: "Identities are managed by the host" };
  }
  if (sub.startsWith("/history/restore")) return { status: 403, error: "Restoring history is host-only" };
  if (sub.startsWith("/history")) {
    return s.allowHistory ? null : { status: 403, error: "History is not shared for this link" };
  }
  if (sub.startsWith("/compile")) {
    return s.allowCompile ? null : { status: 403, error: "Compiling is disabled for this link" };
  }
  if (sub.startsWith("/download")) {
    if (!s.allowDownload) return { status: 403, error: "Downloads are disabled for this link" };
    return null;
  }
  if (s.readOnly) {
    const mutating =
      m !== "GET" &&
      (sub.startsWith("/files") || sub.startsWith("/fs/") || sub.startsWith("/collab/flush"));
    if (mutating) return { status: 403, error: "This link is read-only" };
  }
  return null;
}

/**
 * Express middleware. Runs before all routers. Static assets and the SPA
 * shell are always served (the client decides what to show); `/api/guest/*`
 * is open so guests can sign in; everything else on a tunnel host needs a
 * valid guest cookie and passes the per-share permission check.
 */
export function shareGate(req: Request, res: Response, next: NextFunction): void {
  if (!isTunnelRequest(req)) {
    req.access = { mode: "host" };
    next();
    return;
  }

  const isApi = req.path.startsWith("/api/");
  const isCollab = req.path.startsWith("/collab");
  if (!isApi && !isCollab) {
    // SPA shell / assets. No access object: the client will call /api/guest/me.
    next();
    return;
  }
  if (req.path.startsWith("/api/guest") || req.path === "/api/health") {
    next();
    return;
  }

  const r = resolveGuest(req);
  if (r.reason === "no-session") {
    res.status(404).json({ error: "This share link is no longer active" });
    return;
  }
  if (r.reason === "expired") {
    res.status(410).json({ error: "This share link has expired" });
    return;
  }
  if (r.reason === "unauthenticated") {
    res.status(401).json({ error: "Sign in required", code: "GUEST_AUTH" });
    return;
  }

  const denial = guestRouteDenial(req, r.session);
  if (denial) {
    res.status(denial.status).json({ error: denial.error });
    return;
  }
  req.access = { mode: "guest", session: r.session, guest: r.guest };
  next();
}

export function hostOnly(req: Request, res: Response, next: NextFunction): void {
  if (req.access?.mode === "host") {
    next();
    return;
  }
  res.status(403).json({ error: "Host-only" });
}
