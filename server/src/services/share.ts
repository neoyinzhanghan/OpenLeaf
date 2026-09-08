import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { projectDir } from "./projectFs.js";

/**
 * Per-project public sharing over a Cloudflare Quick Tunnel.
 *
 * One session = one `cloudflared` child process = one random
 * `https://<words>.trycloudflare.com` hostname that only routes to one
 * project. Everything lives in memory: stopping the session (or restarting
 * the server) kills the tunnel, invalidates every guest cookie and the next
 * start issues a brand-new link and credentials.
 */

export type ShareSettings = {
  /** Epoch ms after which the session self-terminates and all tokens fail. */
  expiresAt: number;
  /** Maximum number of distinct client IPs that may authenticate over the session's life. */
  maxIps: number;
  /** Maximum number of guest sign-ins (people) over the session's life. */
  maxGuests: number;
  /** Guests can read and follow along but cannot change files. */
  readOnly: boolean;
  allowCompile: boolean;
  allowDownload: boolean;
  /** Guests may view the git history (restore is always host-only). */
  allowHistory: boolean;
};

export type Guest = {
  id: string;
  name: string;
  color: string;
  ip: string;
  joinedAt: number;
  lastSeen: number;
  revoked: boolean;
};

export type ShareStatus = "starting" | "active" | "stopped" | "error";

export type ShareSession = {
  id: string;
  projectId: string;
  hostname: string;
  url: string;
  username: string;
  password: string;
  secret: Buffer;
  createdAt: number;
  settings: ShareSettings;
  /** ip -> first seen */
  ips: Map<string, number>;
  guests: Map<string, Guest>;
  loginFailures: Map<string, { count: number; first: number }>;
  proc: ChildProcess | null;
  status: ShareStatus;
  error?: string;
  expiryTimer: NodeJS.Timeout | null;
  logTail: string[];
};

export type ShareError = Error & { status: number };

function shareError(status: number, message: string): ShareError {
  return Object.assign(new Error(message), { status });
}

const sessionsByProject = new Map<string, ShareSession>();
const sessionsByHost = new Map<string, ShareSession>();

const GUEST_COLORS = [
  "#EF4444",
  "#F97316",
  "#EAB308",
  "#22C55E",
  "#14B8A6",
  "#3B82F6",
  "#8B5CF6",
  "#EC4899",
  "#06B6D4",
  "#84CC16",
];

const WORDS = (
  "amber apple arbor arrow aspen atlas azure badge basil beacon birch bloom bluff brass breeze brook cabin candle canyon cedar " +
  "cello chalk cider cliff clover cobalt comet copper coral cove crane creek crest daisy dawn delta dune ember fable falcon " +
  "fern fjord flint forest frost garnet glade glen grove harbor hazel heron hollow indigo iris ivory jade juniper kestrel " +
  "lagoon lantern larch laurel lemon lilac linen lotus lumen maple marble meadow mesa mint mist moss nectar nickel north " +
  "oak ocean olive onyx opal orchid otter oxbow pebble pine plum poppy prism quartz quill raven reef ridge river robin " +
  "rowan ruby sable saffron sage sand satin sequoia shale shore sierra silver slate sorrel spruce stone summit sunset " +
  "tansy teal thistle thyme tidal timber topaz trail tulip tundra umber valley velvet vesper violet walnut wave willow " +
  "winter wren yarrow zephyr zinc"
).split(/\s+/);

function pick<T>(list: T[]): T {
  return list[crypto.randomInt(list.length)]!;
}

function makeUsername(): string {
  return `${pick(WORDS)}-${pick(WORDS)}`;
}

function makePassword(): string {
  return `${pick(WORDS)}-${pick(WORDS)}-${pick(WORDS)}-${crypto.randomInt(10, 100)}`;
}

function findCloudflared(): string {
  const explicit = process.env.OPENLEAF_CLOUDFLARED;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.join(os.homedir(), ".local", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/opt/homebrew/bin",
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    const bin = path.join(dir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
    if (fs.existsSync(bin)) return bin;
  }
  throw shareError(
    500,
    "cloudflared not found. Install it (https://github.com/cloudflare/cloudflared/releases) or set OPENLEAF_CLOUDFLARED.",
  );
}

export function cloudflaredAvailable(): { available: boolean; path?: string; error?: string } {
  try {
    return { available: true, path: findCloudflared() };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function normalizeSettings(input: Partial<ShareSettings> | undefined): ShareSettings {
  const now = Date.now();
  const defaults: ShareSettings = {
    expiresAt: now + 4 * 3600_000,
    maxIps: 5,
    maxGuests: 10,
    readOnly: false,
    allowCompile: true,
    allowDownload: true,
    allowHistory: true,
  };
  const s: ShareSettings = { ...defaults, ...(input ?? {}) };
  if (!Number.isFinite(s.expiresAt) || s.expiresAt <= now + 60_000) {
    throw shareError(400, "Expiry must be at least one minute in the future");
  }
  if (s.expiresAt > now + 30 * 24 * 3600_000) {
    throw shareError(400, "Expiry cannot be more than 30 days out");
  }
  s.maxIps = Math.floor(s.maxIps);
  s.maxGuests = Math.floor(s.maxGuests);
  if (!Number.isFinite(s.maxIps) || s.maxIps < 1 || s.maxIps > 1000) {
    throw shareError(400, "maxIps must be between 1 and 1000");
  }
  if (!Number.isFinite(s.maxGuests) || s.maxGuests < 1 || s.maxGuests > 1000) {
    throw shareError(400, "maxGuests must be between 1 and 1000");
  }
  return s;
}

/** What the host sees (includes the password; local requests only). */
export function hostView(s: ShareSession) {
  return {
    id: s.id,
    projectId: s.projectId,
    status: s.status,
    error: s.error,
    url: s.url,
    hostname: s.hostname,
    username: s.username,
    password: s.password,
    createdAt: s.createdAt,
    settings: s.settings,
    ipsUsed: s.ips.size,
    guests: Array.from(s.guests.values()).map((g) => ({ ...g })),
    logTail: s.logTail.slice(-12),
  };
}

/** What a guest may learn about the session they are in. */
export function guestView(s: ShareSession) {
  return {
    projectId: s.projectId,
    expiresAt: s.settings.expiresAt,
    readOnly: s.settings.readOnly,
    allowCompile: s.settings.allowCompile,
    allowDownload: s.settings.allowDownload,
    allowHistory: s.settings.allowHistory,
  };
}

export function getShare(projectId: string): ShareSession | undefined {
  return sessionsByProject.get(projectId);
}

export function listShares(): ShareSession[] {
  return Array.from(sessionsByProject.values());
}

export function getShareByHost(hostHeader: string | undefined): ShareSession | undefined {
  if (!hostHeader) return undefined;
  const host = hostHeader.toLowerCase().split(":")[0] ?? "";
  return sessionsByHost.get(host);
}

export function isExpired(s: ShareSession): boolean {
  return Date.now() >= s.settings.expiresAt;
}

function pushLog(s: ShareSession, line: string) {
  s.logTail.push(line);
  if (s.logTail.length > 60) s.logTail.splice(0, s.logTail.length - 60);
}

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export async function startShare(projectId: string, input: Partial<ShareSettings> | undefined): Promise<ShareSession> {
  const dir = projectDir(projectId);
  if (!fs.existsSync(dir)) throw shareError(404, "Project not found");
  const existing = sessionsByProject.get(projectId);
  if (existing && (existing.status === "active" || existing.status === "starting")) {
    throw shareError(409, "This project already has an active share session");
  }
  const settings = normalizeSettings(input);
  const bin = findCloudflared();
  const port = loadConfig().port;

  const session: ShareSession = {
    id: crypto.randomUUID(),
    projectId,
    hostname: "",
    url: "",
    username: makeUsername(),
    password: makePassword(),
    secret: crypto.randomBytes(32),
    createdAt: Date.now(),
    settings,
    ips: new Map(),
    guests: new Map(),
    loginFailures: new Map(),
    proc: null,
    status: "starting",
    expiryTimer: null,
    logTail: [],
  };
  sessionsByProject.set(projectId, session);

  const proc = spawn(
    bin,
    ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate", "--protocol", "quic"],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } },
  );
  session.proc = proc;

  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Timed out waiting for the Cloudflare tunnel to come up (45s)")), 45_000);

    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        pushLog(session, line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s+/, ""));
        if (!session.url) {
          const m = line.match(TUNNEL_URL_RE);
          if (m) {
            session.url = m[0].toLowerCase();
            session.hostname = new URL(session.url).hostname;
            sessionsByHost.set(session.hostname, session);
          }
        }
        if (session.url && /Registered tunnel connection/i.test(line)) {
          finish();
        }
        if (/failed to request quick Tunnel|ERR .*(unable|cannot|failed to (connect|dial))/i.test(line) && !session.url) {
          finish(new Error(line.replace(/^.*?ERR\s*/, "")));
        }
      }
    };
    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
    proc.once("error", (err) => finish(err));
    proc.once("exit", (code, signal) => {
      finish(new Error(`cloudflared exited early (${signal ?? code ?? "unknown"})`));
    });
  });

  proc.on("exit", (code, signal) => {
    pushLog(session, `cloudflared exited (${signal ?? code ?? "unknown"})`);
    if (session.status === "active") {
      session.status = "stopped";
      session.error = "Tunnel process exited";
    }
    teardown(session);
  });

  try {
    await ready;
  } catch (err) {
    session.status = "error";
    session.error = err instanceof Error ? err.message : String(err);
    killProc(session);
    teardown(session);
    sessionsByProject.delete(projectId);
    throw shareError(502, `Could not start the public link: ${session.error}`);
  }

  session.status = "active";
  session.expiryTimer = setTimeout(() => {
    pushLog(session, "Session expired");
    void stopShare(projectId, "expired");
  }, Math.min(settings.expiresAt - Date.now(), 2 ** 31 - 1));
  console.log(`[share] ${projectId} -> ${session.url} (expires ${new Date(settings.expiresAt).toISOString()})`);
  return session;
}

function killProc(s: ShareSession) {
  const p = s.proc;
  if (!p || p.exitCode !== null || p.killed) return;
  try {
    p.kill("SIGTERM");
    const t = setTimeout(() => {
      try {
        if (p.exitCode === null) p.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 3000);
    t.unref();
  } catch {
    /* ignore */
  }
}

function teardown(s: ShareSession) {
  if (s.expiryTimer) {
    clearTimeout(s.expiryTimer);
    s.expiryTimer = null;
  }
  if (s.hostname && sessionsByHost.get(s.hostname) === s) sessionsByHost.delete(s.hostname);
  // Rotating the secret makes every outstanding cookie fail even if the
  // session object is still referenced somewhere.
  s.secret = crypto.randomBytes(32);
}

export async function stopShare(projectId: string, reason = "stopped by host"): Promise<boolean> {
  const s = sessionsByProject.get(projectId);
  if (!s) return false;
  pushLog(s, `Stopping: ${reason}`);
  s.status = "stopped";
  killProc(s);
  teardown(s);
  sessionsByProject.delete(projectId);
  console.log(`[share] ${projectId} stopped (${reason})`);
  return true;
}

export function revokeGuest(projectId: string, guestId: string): boolean {
  const s = sessionsByProject.get(projectId);
  const g = s?.guests.get(guestId);
  if (!s || !g) return false;
  g.revoked = true;
  return true;
}

export function stopAllShares(): void {
  for (const id of Array.from(sessionsByProject.keys())) void stopShare(id, "server shutdown");
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(sig, () => {
    stopAllShares();
    // Give cloudflared a moment to receive SIGTERM before we exit.
    setTimeout(() => process.exit(0), 200).unref();
  });
}
process.once("exit", () => {
  for (const s of sessionsByProject.values()) killProc(s);
});

/* ------------------------------------------------------------------ */
/* Guest authentication                                                */
/* ------------------------------------------------------------------ */

const MAX_LOGIN_FAILURES = 8;
const LOGIN_FAILURE_WINDOW_MS = 10 * 60_000;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Compare against self to keep timing flat, then fail.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function sign(s: ShareSession, guestId: string): string {
  return crypto.createHmac("sha256", s.secret).update(`${s.id}:${guestId}`).digest("base64url");
}

export function makeGuestToken(s: ShareSession, guestId: string): string {
  return `${Buffer.from(guestId, "utf8").toString("base64url")}.${sign(s, guestId)}`;
}

/** Admits `ip` if it is already known or there is room; returns false when the IP cap is hit. */
function admitIp(s: ShareSession, ip: string): boolean {
  if (s.ips.has(ip)) return true;
  if (s.ips.size >= s.settings.maxIps) return false;
  s.ips.set(ip, Date.now());
  return true;
}

export function verifyGuestToken(s: ShareSession, token: string | undefined, ip: string): Guest | null {
  if (!token) return null;
  if (s.status !== "active" || isExpired(s)) return null;
  const [gidB64, sig] = token.split(".");
  if (!gidB64 || !sig) return null;
  let guestId: string;
  try {
    guestId = Buffer.from(gidB64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!safeEqual(sig, sign(s, guestId))) return null;
  const g = s.guests.get(guestId);
  if (!g || g.revoked) return null;
  if (!admitIp(s, ip)) return null;
  g.lastSeen = Date.now();
  if (g.ip !== ip) g.ip = ip;
  return g;
}

export function guestLogin(
  s: ShareSession,
  creds: { username: string; password: string; displayName: string },
  ip: string,
): { guest: Guest; token: string } {
  if (s.status !== "active") throw shareError(410, "This share link is no longer active");
  if (isExpired(s)) throw shareError(410, "This share link has expired");

  const fail = s.loginFailures.get(ip);
  const now = Date.now();
  if (fail && now - fail.first < LOGIN_FAILURE_WINDOW_MS && fail.count >= MAX_LOGIN_FAILURES) {
    throw shareError(429, "Too many failed attempts from this address. Try again later.");
  }

  const name = creds.displayName.trim().replace(/\s+/g, " ").slice(0, 40);
  if (name.length < 1) throw shareError(400, "Please tell us who you are (display name)");

  const okUser = safeEqual(creds.username.trim().toLowerCase(), s.username);
  const okPass = safeEqual(creds.password.trim(), s.password);
  if (!okUser || !okPass) {
    if (!fail || now - fail.first >= LOGIN_FAILURE_WINDOW_MS) {
      s.loginFailures.set(ip, { count: 1, first: now });
    } else {
      fail.count += 1;
    }
    throw shareError(401, "Wrong username or password");
  }

  if (!admitIp(s, ip)) {
    throw shareError(403, `This link is limited to ${s.settings.maxIps} device address${s.settings.maxIps === 1 ? "" : "es"} and that limit has been reached`);
  }
  const live = Array.from(s.guests.values()).filter((g) => !g.revoked).length;
  if (live >= s.settings.maxGuests) {
    throw shareError(403, `This link is limited to ${s.settings.maxGuests} guest${s.settings.maxGuests === 1 ? "" : "s"} and that limit has been reached`);
  }

  const id = `guest-${crypto.randomBytes(5).toString("hex")}`;
  const usedColors = new Set(Array.from(s.guests.values()).map((g) => g.color));
  const color = GUEST_COLORS.find((c) => !usedColors.has(c)) ?? pick(GUEST_COLORS);
  const guest: Guest = { id, name, color, ip, joinedAt: now, lastSeen: now, revoked: false };
  s.guests.set(id, guest);
  s.loginFailures.delete(ip);
  console.log(`[share] ${s.projectId}: guest "${name}" joined from ${ip}`);
  return { guest, token: makeGuestToken(s, id) };
}

export function guestLogout(s: ShareSession, guestId: string): void {
  const g = s.guests.get(guestId);
  if (g) g.revoked = true;
}
