import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getConfigDir, writeFileAtomic } from "../config.js";

/**
 * Paired phones and other remote host sessions.
 * Pairing tokens live only in memory, and only as a SHA-256 hash.
 * Devices live in config/host-devices.json (mode 0600).
 */

export type DeviceRoute = "lan" | "tunnel" | "password";

export type HostDevice = {
  id: string;
  label: string;
  userAgent: string;
  route: DeviceRoute;
  createdAt: number;
  lastSeenAt: number;
  lastIp: string;
  revokedAt?: number;
};

type DeviceFile = { devices: HostDevice[] };

type Pairing = {
  id: string;
  tokenHash: string;
  route: "lan" | "tunnel";
  lanAddress?: string;
  next?: string;
  expiresAt: number;
  redeemedDeviceId?: string;
};

const REVOKED_KEEP_MS = 90 * 24 * 3600_000;
const PAIRING_TTL_MS = 10 * 60_000;
const MAX_OUTSTANDING = 5;
const DEVICE_TTL_MS = 30 * 24 * 3600_000;
const TOUCH_MIN_MS = 60_000;
const REDEEM_WINDOW_MS = 10 * 60_000;
const REDEEM_LIMIT = 20;

const pairings = new Map<string, Pairing>();
const redeemAttempts = new Map<string, { count: number; first: number }>();

function devicesPath(): string {
  const dir = process.env.OPENLEAF_HOST_AUTH_DIR || getConfigDir();
  return path.join(dir, "host-devices.json");
}

function authPath(): string {
  const dir = process.env.OPENLEAF_HOST_AUTH_DIR || getConfigDir();
  return path.join(dir, "host-auth.json");
}

function cookieSecret(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(authPath(), "utf8")) as { cookieSecret?: string };
    return raw.cookieSecret || null;
  } catch {
    return null;
  }
}

let deviceCache: { path: string; mtimeMs: number; devices: HostDevice[] } | null = null;

function loadDevices(): HostDevice[] {
  const file = devicesPath();
  try {
    const stat = fs.statSync(file);
    if (deviceCache && deviceCache.path === file && deviceCache.mtimeMs === stat.mtimeMs) {
      return deviceCache.devices.map((device) => ({ ...device }));
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as DeviceFile;
    const loaded = Array.isArray(raw.devices) ? raw.devices : [];
    const cutoff = Date.now() - REVOKED_KEEP_MS;
    const devices = loaded.filter((device) => !device.revokedAt || device.revokedAt >= cutoff);
    if (devices.length !== loaded.length) {
      saveDevices(devices);
      return devices.map((device) => ({ ...device }));
    }
    deviceCache = { path: file, mtimeMs: stat.mtimeMs, devices };
    return devices.map((device) => ({ ...device }));
  } catch {
    return [];
  }
}

function saveDevices(devices: HostDevice[]): void {
  const file = devicesPath();
  writeFileAtomic(devicesPath(), `${JSON.stringify({ devices }, null, 2)}\n`, 0o600);
  try {
    deviceCache = { path: file, mtimeMs: fs.statSync(file).mtimeMs, devices };
  } catch {
    deviceCache = null;
  }
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

function sign(secret: string, payload: string): string {
  return crypto.createHmac("sha256", Buffer.from(secret, "base64")).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function labelFromUserAgent(userAgent: string): string {
  const ua = userAgent || "";
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : "Device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Safari\//.test(ua) && !/Chrome\//.test(ua)
        ? "Safari"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : "browser";
  return `${device} · ${browser}`;
}

export function createPairing(input: {
  route: "lan" | "tunnel";
  lanAddress?: string;
  next?: string;
}): { id: string; token: string; expiresAt: number } {
  const now = Date.now();
  for (const [id, pairing] of pairings) {
    if (pairing.redeemedDeviceId || pairing.expiresAt <= now) pairings.delete(id);
  }
  if ([...pairings.values()].filter((pairing) => !pairing.redeemedDeviceId && pairing.expiresAt > now).length >= MAX_OUTSTANDING) {
    throw Object.assign(new Error("Too many unused links. Cancel one, or wait for them to expire."), { status: 429 });
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const id = crypto.randomBytes(8).toString("base64url");
  const expiresAt = now + PAIRING_TTL_MS;
  pairings.set(id, {
    id,
    tokenHash: hashToken(token),
    route: input.route,
    lanAddress: input.lanAddress,
    next: input.next,
    expiresAt,
  });
  return { id, token, expiresAt };
}

export function getPairing(id: string): {
  status: "pending" | "redeemed" | "expired";
  expiresAt: number;
  device?: HostDevice;
} | null {
  const pairing = pairings.get(id);
  if (!pairing) return null;
  if (pairing.redeemedDeviceId) {
    const device = loadDevices().find((item) => item.id === pairing.redeemedDeviceId);
    return { status: "redeemed", expiresAt: pairing.expiresAt, device };
  }
  if (pairing.expiresAt <= Date.now()) return { status: "expired", expiresAt: pairing.expiresAt };
  return { status: "pending", expiresAt: pairing.expiresAt };
}

export function cancelPairing(id: string): boolean {
  return pairings.delete(id);
}

export function outstandingPairingCount(): number {
  const now = Date.now();
  let count = 0;
  for (const pairing of pairings.values()) {
    if (!pairing.redeemedDeviceId && pairing.expiresAt > now) count += 1;
  }
  return count;
}

function redeemLimited(ip: string): boolean {
  const now = Date.now();
  const row = redeemAttempts.get(ip);
  if (!row || now - row.first >= REDEEM_WINDOW_MS) {
    redeemAttempts.set(ip, { count: 1, first: now });
    return false;
  }
  row.count += 1;
  return row.count > REDEEM_LIMIT;
}

export function redeemPairing(
  token: string,
  meta: { userAgent: string; ip: string },
): { device: HostDevice; sessionToken: string; next?: string } | null {
  if (redeemLimited(meta.ip)) return null;
  const tokenHash = hashToken(token);
  const now = Date.now();
  for (const pairing of pairings.values()) {
    if (pairing.redeemedDeviceId) continue;
    if (pairing.expiresAt <= now) continue;
    if (!safeEqual(pairing.tokenHash, tokenHash)) continue;
    const device = insertDevice({
      label: labelFromUserAgent(meta.userAgent),
      userAgent: meta.userAgent.slice(0, 300),
      route: pairing.route,
      ip: meta.ip,
    });
    pairing.redeemedDeviceId = device.id;
    const sessionToken = mintDeviceToken(device.id);
    if (!sessionToken) return null;
    return { device, sessionToken, next: pairing.next };
  }
  return null;
}

function insertDevice(input: { label: string; userAgent: string; route: DeviceRoute; ip: string }): HostDevice {
  const now = Date.now();
  const device: HostDevice = {
    id: crypto.randomBytes(12).toString("base64url"),
    label: input.label.slice(0, 80) || "Device",
    userAgent: input.userAgent,
    route: input.route,
    createdAt: now,
    lastSeenAt: now,
    lastIp: input.ip,
  };
  const devices = loadDevices();
  devices.push(device);
  saveDevices(devices);
  return device;
}

export function createPasswordDevice(meta: { userAgent: string; ip: string }): { device: HostDevice; sessionToken: string } {
  const device = insertDevice({
    label: labelFromUserAgent(meta.userAgent),
    userAgent: meta.userAgent.slice(0, 300),
    route: "password",
    ip: meta.ip,
  });
  const sessionToken = mintDeviceToken(device.id);
  if (!sessionToken) {
    throw Object.assign(new Error("Host login is not configured"), { status: 500 });
  }
  return { device, sessionToken };
}

export function listDevices(): HostDevice[] {
  return loadDevices();
}

export function renameDevice(id: string, label: string): HostDevice | null {
  const devices = loadDevices();
  const device = devices.find((item) => item.id === id);
  if (!device || device.revokedAt) return null;
  device.label = label.trim().slice(0, 80);
  saveDevices(devices);
  return device;
}

export function revokeDevice(id: string): boolean {
  const devices = loadDevices();
  const device = devices.find((item) => item.id === id);
  if (!device || device.revokedAt) return false;
  device.revokedAt = Date.now();
  saveDevices(devices);
  return true;
}

export function revokeAllDevices(): void {
  const now = Date.now();
  const devices = loadDevices().map((device) => (device.revokedAt ? device : { ...device, revokedAt: now }));
  saveDevices(devices);
}

export function mintDeviceToken(deviceId: string, username?: string): string | null {
  const secret = cookieSecret();
  if (!secret) return null;
  let user = username;
  if (!user) {
    try {
      const raw = JSON.parse(fs.readFileSync(authPath(), "utf8")) as { username?: string };
      user = raw.username || "host";
    } catch {
      user = "host";
    }
  }
  const body = Buffer.from(
    JSON.stringify({ u: user, sid: deviceId, exp: Date.now() + DEVICE_TTL_MS }),
    "utf8",
  ).toString("base64url");
  const payload = `v2.${body}`;
  return `${payload}.${sign(secret, payload)}`;
}

export type DeviceSession = {
  username: string;
  deviceId: string;
  refreshedToken?: string;
};

export function verifyDeviceToken(token: string | undefined, ip?: string): DeviceSession | null {
  if (!token || token.startsWith("v1.")) return null;
  const secret = cookieSecret();
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v2") return null;
  const payload = `${parts[0]}.${parts[1]}`;
  if (!safeEqual(parts[2] ?? "", sign(secret, payload))) return null;
  let body: { u?: string; sid?: string; exp?: number };
  try {
    body = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as {
      u?: string;
      sid?: string;
      exp?: number;
    };
  } catch {
    return null;
  }
  if (typeof body.u !== "string" || typeof body.sid !== "string" || typeof body.exp !== "number") return null;
  if (Date.now() > body.exp) return null;
  const devices = loadDevices();
  const device = devices.find((item) => item.id === body.sid);
  if (!device || device.revokedAt) return null;
  let refreshedToken: string | undefined;
  if (Date.now() - device.lastSeenAt >= TOUCH_MIN_MS) {
    device.lastSeenAt = Date.now();
    if (ip) device.lastIp = ip;
    saveDevices(devices);
    refreshedToken = mintDeviceToken(device.id, body.u) ?? undefined;
  }
  return { username: body.u, deviceId: device.id, refreshedToken };
}

/** Test hook. */
export function resetHostDevicesForTests(): void {
  pairings.clear();
  redeemAttempts.clear();
}

export function expirePairingForTests(id: string): void {
  const pairing = pairings.get(id);
  if (pairing) pairing.expiresAt = Date.now() - 1;
}
