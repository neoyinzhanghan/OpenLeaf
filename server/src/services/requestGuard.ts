import type { IncomingMessage } from "node:http";
import os from "node:os";
import { loadConfig } from "../config.js";

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function socketIsLoopback(req: IncomingMessage): boolean {
  return isLoopbackAddress(req.socket?.remoteAddress ?? "");
}

export function isLoopbackAddress(address: string): boolean {
  const ip = address.replace(/^::ffff:/i, "").toLowerCase();
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost";
}

/** Client IP. Forwarded headers count only when the socket peer is loopback (Vite, cloudflared). */
export function effectiveClientIp(req: IncomingMessage): string {
  if (socketIsLoopback(req)) {
    const cf = headerOne(req.headers["cf-connecting-ip"]);
    if (cf) return cf;
    const xff = headerOne(req.headers["x-forwarded-for"]);
    if (xff) return xff.split(",")[0]!.trim();
  }
  const raw = req.socket?.remoteAddress ?? "unknown";
  return raw.replace(/^::ffff:/i, "");
}

function headerOne(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return value?.trim() ?? "";
}

export function hostnameOf(req: IncomingMessage): string {
  const raw = (req.headers.host ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end > 0 ? raw.slice(1, end) : raw;
  }
  return raw.split(":")[0] ?? "";
}

export function isKnownTunnelHost(host: string): boolean {
  return host.endsWith(".trycloudflare.com");
}

export function allowedHostNames(): Set<string> {
  const names = new Set<string>(LOOPBACK_NAMES);
  const host = os.hostname().trim().toLowerCase();
  if (host) {
    names.add(host);
    names.add(`${host}.local`);
  }
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets ?? []) {
      if (!net.address) continue;
      names.add(net.address.toLowerCase());
      names.add(net.address.toLowerCase().replace(/^::ffff:/, ""));
    }
  }
  for (const extra of loadConfig().allowedHosts ?? []) {
    const name = extra.trim().toLowerCase();
    if (name) names.add(name);
  }
  return names;
}

export function hostHeaderAllowed(req: IncomingMessage): boolean {
  const host = hostnameOf(req);
  if (!host) return socketIsLoopback(req);
  if (isKnownTunnelHost(host)) return true;
  return allowedHostNames().has(host);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * State-changing requests need a matching Origin when one is sent.
 * A missing Origin is allowed only from loopback (curl, CLI).
 * Safe methods with no Origin are ordinary browser navigations.
 */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = headerOne(req.headers.origin);
  const method = (req.method ?? "GET").toUpperCase();
  if (!origin) {
    if (SAFE_METHODS.has(method)) return true;
    return socketIsLoopback(req) && isLoopbackAddress(effectiveClientIp(req));
  }
  let hostname = "";
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  const host = hostnameOf(req);
  if (hostname === host) return true;
  if (LOOPBACK_NAMES.has(hostname) && LOOPBACK_NAMES.has(host)) return true;
  return allowedHostNames().has(hostname) && allowedHostNames().has(host);
}

/** Owner without a device cookie: loopback socket (after forwarded-for) and a loopback Host name. */
export function isLoopbackOwner(req: IncomingMessage): boolean {
  return isLoopbackAddress(effectiveClientIp(req)) && LOOPBACK_NAMES.has(hostnameOf(req));
}

export function lanAuthIsOpen(): boolean {
  return loadConfig().lanAuth === "open";
}
