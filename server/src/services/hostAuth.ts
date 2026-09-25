import crypto from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { getConfigDir, loadConfig } from "../config.js";

/**
 * Password gate for the public host Cloudflare URL.
 * LAN / localhost stays unauthenticated; only the host-gateway hostname
 * requires this cookie. Credentials are generated once and stored locally
 * (never in git, never in the public config PATCH surface).
 */

export const HOST_COOKIE = "openleaf_host";
/** Used only when setup has not chosen an operator username. Not a collab identity. */
export const HOST_USERNAME_DEFAULT = "host";

const COOKIE_TTL_MS = 14 * 24 * 3600_000;
const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS: crypto.ScryptOptions = { N: 16384, r: 8, p: 1 };
const MAX_LOGIN_FAILURES = 8;
const LOGIN_FAILURE_WINDOW_MS = 10 * 60_000;

type HostAuthFile = {
  username: string;
  salt: string;
  passwordHash: string;
  cookieSecret: string;
  createdAt: number;
};

const loginFailures = new Map<string, { count: number; first: number }>();

function authDir(): string {
  return process.env.OPENLEAF_HOST_AUTH_DIR || getConfigDir();
}

function authPath(): string {
  return path.join(authDir(), "host-auth.json");
}

function credentialsPath(): string {
  return path.join(authDir(), "host-credentials.txt");
}

function readJsonIfExists(filePath: string): HostAuthFile | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as HostAuthFile;
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function hashPassword(password: string, salt: Buffer): string {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS).toString("base64");
}

/** 24-char base64url in three blocks — ~144 bits, easy to type on a phone. */
export function generateHostPassword(): string {
  const raw = crypto.randomBytes(18).toString("base64url");
  return `${raw.slice(0, 8)}-${raw.slice(8, 16)}-${raw.slice(16)}`;
}

function writeFilePrivate(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* windows */
  }
}

function writeCredentialsFile(username: string, password: string, publicUrl?: string): void {
  const lines = [
    "OpenLeaf host login (public Cloudflare URL)",
    `Username: ${username}`,
    `Password: ${password}`,
    `Public URL: ${publicUrl?.trim() || "(starting…)"}`,
    "",
    "LAN / localhost does not require this login.",
    "The public URL may change if OpenLeaf or the Cloudflare tunnel restarts.",
    "",
  ];
  writeFilePrivate(credentialsPath(), lines.join("\n"));
}

export function readPlainHostPassword(): string | null {
  if (!fs.existsSync(credentialsPath())) return null;
  const text = fs.readFileSync(credentialsPath(), "utf8");
  const m = text.match(/^Password:\s*(.+)$/m);
  return m?.[1]?.trim() || null;
}

export function updateHostCredentialsUrl(publicUrl: string): void {
  const auth = loadHostAuth();
  const password = readPlainHostPassword();
  if (!auth || !password) return;
  writeCredentialsFile(auth.username, password, publicUrl);
}

function persistAuth(file: HostAuthFile): void {
  writeFilePrivate(authPath(), `${JSON.stringify(file, null, 2)}\n`);
  try {
    cachedMtime = fs.statSync(authPath()).mtimeMs;
  } catch {
    cachedMtime = 0;
  }
}

/**
 * Replace the host password and rotate the cookie secret so existing
 * host sessions stop verifying. Does not print the password.
 */
export function resetHostPassword(password: string): { username: string } {
  const trimmed = password.trim();
  if (trimmed.length < 8) {
    throw Object.assign(new Error("Password must be at least 8 characters"), { status: 400 });
  }
  const existing = loadHostAuth();
  if (!existing) {
    throw Object.assign(new Error("Host login is not configured yet"), { status: 404 });
  }
  const salt = crypto.randomBytes(16);
  const file: HostAuthFile = {
    ...existing,
    salt: salt.toString("base64"),
    passwordHash: hashPassword(trimmed, salt),
    cookieSecret: crypto.randomBytes(32).toString("base64"),
  };
  const previous = fs.existsSync(credentialsPath()) ? fs.readFileSync(credentialsPath(), "utf8") : "";
  const urlMatch = previous.match(/^Public URL:\s*(.+)$/m);
  persistAuth(file);
  writeCredentialsFile(existing.username, trimmed, urlMatch?.[1]?.trim());
  cached = file;
  return { username: existing.username };
}

let cached: HostAuthFile | null = null;
let cachedMtime = 0;

export function loadHostAuth(): HostAuthFile | null {
  const filePath = authPath();
  let mtime = 0;
  try {
    mtime = fs.statSync(filePath).mtimeMs;
  } catch {
    cached = null;
    cachedMtime = 0;
    return null;
  }
  if (cached && mtime === cachedMtime) return cached;
  const file = readJsonIfExists(filePath);
  if (!file?.username || !file.salt || !file.passwordHash || !file.cookieSecret) {
    cached = null;
    cachedMtime = 0;
    return null;
  }
  cached = file;
  cachedMtime = mtime;
  return cached;
}

/**
 * Create credentials on first boot. Never regenerates an existing password
 * (delete config/host-auth.json + host-credentials.txt to rotate).
 */
export function ensureHostAuth(): { created: boolean; username: string; password?: string } {
  const existing = loadHostAuth();
  if (existing) return { created: false, username: existing.username };

  const configured = loadConfig().user?.hostUsername?.trim();
  const username = (process.env.OPENLEAF_HOST_USER || configured || HOST_USERNAME_DEFAULT).trim() || HOST_USERNAME_DEFAULT;
  const password = (process.env.OPENLEAF_HOST_PASSWORD || "").trim() || generateHostPassword();
  const salt = crypto.randomBytes(16);
  const file: HostAuthFile = {
    username,
    salt: salt.toString("base64"),
    passwordHash: hashPassword(password, salt),
    cookieSecret: crypto.randomBytes(32).toString("base64"),
    createdAt: Date.now(),
  };
  persistAuth(file);
  writeCredentialsFile(username, password);
  cached = file;
  return { created: true, username, password };
}

export function hostCookieHeader(token: string): string {
  const exp = new Date(Date.now() + COOKIE_TTL_MS).toUTCString();
  return `${HOST_COOKIE}=${encodeURIComponent(token)}; Path=/; Expires=${exp}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearHostCookieHeader(): string {
  return `${HOST_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return part.slice(i + 1).trim();
    }
  }
  return undefined;
}

function signPayload(secretB64: string, payload: string): string {
  const secret = Buffer.from(secretB64, "base64");
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function mintHostToken(username = loadHostAuth()?.username ?? HOST_USERNAME_DEFAULT): string {
  const auth = loadHostAuth();
  if (!auth) throw Object.assign(new Error("Host login is not configured"), { status: 500 });
  const body = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + COOKIE_TTL_MS }), "utf8").toString(
    "base64url",
  );
  const payload = `v1.${body}`;
  return `${payload}.${signPayload(auth.cookieSecret, payload)}`;
}

export function verifyHostToken(token: string | undefined): { username: string } | null {
  if (!token) return null;
  const auth = loadHostAuth();
  if (!auth) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const sig = parts[2] ?? "";
  if (!safeEqual(sig, signPayload(auth.cookieSecret, payload))) return null;
  try {
    const body = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as { u?: string; exp?: number };
    if (typeof body.u !== "string" || typeof body.exp !== "number") return null;
    if (Date.now() > body.exp) return null;
    if (!safeEqual(body.u.toLowerCase(), auth.username.toLowerCase())) return null;
    return { username: auth.username };
  } catch {
    return null;
  }
}

export function verifyHostCookie(req: IncomingMessage): { username: string } | null {
  return verifyHostToken(readCookie(req.headers.cookie, HOST_COOKIE));
}

export function hostLogin(
  creds: { username: string; password: string },
  ip: string,
): { username: string; token: string } {
  const auth = loadHostAuth();
  if (!auth) throw Object.assign(new Error("Host login is not configured"), { status: 500 });

  const now = Date.now();
  const fail = loginFailures.get(ip);
  if (fail && now - fail.first < LOGIN_FAILURE_WINDOW_MS && fail.count >= MAX_LOGIN_FAILURES) {
    throw Object.assign(new Error("Too many failed attempts from this address. Try again later."), { status: 429 });
  }

  const userOk = safeEqual(creds.username.trim().toLowerCase(), auth.username.toLowerCase());
  let passOk = false;
  try {
    const salt = Buffer.from(auth.salt, "base64");
    const next = hashPassword(creds.password, salt);
    passOk = safeEqual(next, auth.passwordHash);
  } catch {
    passOk = false;
  }

  if (!userOk || !passOk) {
    if (!fail || now - fail.first >= LOGIN_FAILURE_WINDOW_MS) {
      loginFailures.set(ip, { count: 1, first: now });
    } else {
      fail.count += 1;
    }
    throw Object.assign(new Error("Wrong username or password"), { status: 401 });
  }

  loginFailures.delete(ip);
  return { username: auth.username, token: mintHostToken(auth.username) };
}

/** Test helper: drop cached auth so a new temp dir can be used. */
export function resetHostAuthCache(): void {
  cached = null;
  cachedMtime = 0;
  loginFailures.clear();
}
