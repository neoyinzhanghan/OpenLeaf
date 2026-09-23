import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { isAiGatewayHost } from "./aiGateway.js";
import { verifyHostCookie } from "./hostAuth.js";
import { isHostGatewayHost } from "./hostGateway.js";
import { isGuestForbiddenWritePath } from "./projectFs.js";
import { getShareByHost, isExpired, verifyGuestToken, type Guest, type ShareSession } from "./share.js";

/**
 * Splits traffic into lanes:
 *   - local: localhost / LAN. Machine owner, no login.
 *   - host-gateway: the always-on public Cloudflare URL. Requires host login.
 *   - share: a guest share tunnel. Guest cookie + per-share permissions.
 *   - ai-gateway: AI collaborator tools (Bearer token on `/api/ai/`).
 *   - unknown-tunnel: some other trycloudflare host (ended share, etc.).
 */

export type Access =
  | { mode: "host"; remote?: boolean }
  | { mode: "guest"; session: ShareSession; guest: Guest };

export type RequestLane =
  | { kind: "local" }
  | { kind: "host-gateway" }
  | { kind: "share" }
  | { kind: "ai-gateway" }
  | { kind: "unknown-tunnel" };

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

export function hostnameOf(req: IncomingMessage): string {
  return (req.headers.host ?? "").toLowerCase().split(":")[0] ?? "";
}

export function requestLane(req: IncomingMessage): RequestLane {
  if (getShareByHost(req.headers.host)) return { kind: "share" };
  if (isAiGatewayHost(req.headers.host)) return { kind: "ai-gateway" };
  if (isHostGatewayHost(req.headers.host)) return { kind: "host-gateway" };
  const host = hostnameOf(req);
  if (host.endsWith(".trycloudflare.com")) return { kind: "unknown-tunnel" };
  return { kind: "local" };
}

/** True for any public Cloudflare hostname (share, AI, host gateway, or stale). */
export function isTunnelRequest(req: IncomingMessage): boolean {
  return requestLane(req).kind !== "local";
}

function isOpenHostApi(path: string): boolean {
  return (
    path === "/api/health" ||
    path.startsWith("/api/guest") ||
    path === "/api/host/login" ||
    path === "/api/host/logout" ||
    path === "/api/host/me" ||
    path === "/api/host/gateway" ||
    // Paper share invite: possession of the token is the credential (Paperpile-style).
    path.startsWith("/api/lib-share/") ||
    // Library AI collaborator: Bearer token on /api/library-ai/v1 (not host cookie).
    path.startsWith("/api/library-ai/v1")
  );
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
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
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

export function cookieHeader(token: string, _expiresAt?: number | null): string {
  const exp = new Date(Date.now() + COOKIE_HORIZON_MS).toUTCString();
  return `${GUEST_COOKIE}=${encodeURIComponent(token)}; Path=/; Expires=${exp}; HttpOnly; Secure; SameSite=Lax`;
}

export function linkCookieHeader(token: string, _expiresAt?: number | null): string {
  const exp = new Date(Date.now() + COOKIE_HORIZON_MS).toUTCString();
  return `${LINK_COOKIE}=${encodeURIComponent(token)}; Path=/; Expires=${exp}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookieHeader(): string {
  return `${GUEST_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
}

/** Route-level permissions for an authenticated guest. Returns an error string or null when allowed. */
export function guestRouteDenial(req: Request, session: ShareSession): { status: number; error: string } | null {
  const p = req.path;
  const m = req.method.toUpperCase();
  const s = session.settings;

  const projPrefix = `/api/projects/${encodeURIComponent(session.projectId)}`;
  if (!p.startsWith(projPrefix + "/") && p !== projPrefix) {
    return { status: 403, error: "This link only grants access to one project" };
  }
  const sub = p.slice(projPrefix.length); // "" or "/tree", "/files/...", ...

  if (sub === "") return m === "GET" ? null : { status: 403, error: "Not allowed for guests" };
  if (sub.startsWith("/share/ai") || sub === "/ai" || sub.startsWith("/ai/")) {
    if (s.readOnly && m !== "GET") return { status: 403, error: "This link is read-only — you cannot mint AI links" };
    return null;
  }
  if (sub.startsWith("/share")) return { status: 403, error: "Sharing controls are host-only" };
  if (sub.startsWith("/identities")) {
    return m === "GET" ? null : { status: 403, error: "Identities are managed by the host" };
  }
  if (sub.startsWith("/history/restore")) return { status: 403, error: "Restoring history is host-only" };
  if (
    sub.startsWith("/timeline/fork") ||
    sub.startsWith("/timeline/checkout") ||
    sub.startsWith("/timeline/prune") ||
    sub.startsWith("/timeline/unprune") ||
    sub.startsWith("/timeline/trash")
  ) {
    return { status: 403, error: "Branch navigation and forking are host-only" };
  }
  if (sub.startsWith("/timeline/merge")) {
    return { status: 403, error: "Merging branches is host-only" };
  }
  if (sub.startsWith("/timeline/commit")) {
    if (s.readOnly) return { status: 403, error: "This link is read-only" };
    return null;
  }
  if (sub.startsWith("/branch-leaves") || sub.startsWith("/diff-highlights")) {
    return null;
  }
  if (sub.startsWith("/timeline") || sub.startsWith("/history")) {
    return s.allowHistory ? null : { status: 403, error: "History is not shared for this link" };
  }
  if (sub.startsWith("/compile")) {
    return s.allowCompile ? null : { status: 403, error: "Compiling is disabled for this link" };
  }
  if (sub.startsWith("/track-changes")) {
    if (!s.allowCompile) return { status: 403, error: "Compiling is disabled for this link" };
    return null;
  }
  if (sub.startsWith("/download")) {
    if (!s.allowDownload) return { status: 403, error: "Downloads are disabled for this link" };
    return null;
  }

  if (m !== "GET" && guestTouchesProtectedPath(req, sub)) {
    return { status: 403, error: "This path is not writable through a share link" };
  }

  if (s.readOnly) {
    const mutating =
      m !== "GET" &&
      (sub.startsWith("/files") ||
        sub.startsWith("/fs/") ||
        sub.startsWith("/collab/flush") ||
        sub.startsWith("/comments"));
    if (mutating) return { status: 403, error: "This link is read-only" };
  }
  return null;
}

function guestTouchesProtectedPath(req: Request, sub: string): boolean {
  if (sub.startsWith("/files/")) {
    try {
      return isGuestForbiddenWritePath(decodeURIComponent(sub.slice("/files/".length)));
    } catch {
      return isGuestForbiddenWritePath(sub.slice("/files/".length));
    }
  }
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  if (sub === "/fs/create" || sub === "/fs/mkdir") {
    return typeof body.path === "string" && isGuestForbiddenWritePath(body.path);
  }
  if (sub === "/fs/rename") {
    return (
      (typeof body.from === "string" && isGuestForbiddenWritePath(body.from)) ||
      (typeof body.to === "string" && isGuestForbiddenWritePath(body.to))
    );
  }
  return false;
}

/**
 * Express middleware. Runs before all routers. Static assets and the SPA
 * shell are always served (the client decides what to show). Local traffic is
 * the machine owner. The host-gateway hostname needs a host cookie; share
 * tunnels need a guest cookie.
 */
export function shareGate(req: Request, res: Response, next: NextFunction): void {
  const lane = requestLane(req);
  if (lane.kind === "local") {
    req.access = { mode: "host", remote: false };
    next();
    return;
  }

  const isApi = req.path.startsWith("/api/");
  const isCollab = req.path.startsWith("/collab");
  if (!isApi && !isCollab) {
    next();
    return;
  }

  if (lane.kind === "host-gateway") {
    if (isOpenHostApi(req.path)) {
      next();
      return;
    }
    const host = verifyHostCookie(req);
    if (!host) {
      res.status(401).json({ error: "Sign in required", code: "HOST_AUTH" });
      return;
    }
    req.access = { mode: "host", remote: true };
    next();
    return;
  }

  if (req.path.startsWith("/api/guest") || req.path === "/api/health") {
    next();
    return;
  }
  // AI collaborator tools authenticate with their own Bearer token (not the guest cookie).
  if (req.path.startsWith("/api/ai/")) {
    next();
    return;
  }
  // Library AI tools — Bearer token; must be open on the host gateway (no host login).
  if (req.path.startsWith("/api/library-ai/v1")) {
    next();
    return;
  }

  if (lane.kind === "ai-gateway" || lane.kind === "unknown-tunnel") {
    res.status(404).json({ error: "This share link is no longer active" });
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
