/**
 * Safe HTTP(S) fetch for library web sources. Spec §4.2.
 * Refuses non-http(s), private/loopback/link-local addresses (unless
 * OPENLEAF_ALLOW_PRIVATE_FETCH=1), follows ≤5 redirects with re-check per hop.
 */
import dns from "node:dns/promises";
import { isIP } from "node:net";
import { createHash } from "node:crypto";

const MAX_WEB_BYTES = 5 * 1024 * 1024;
const WEB_FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

export function allowPrivateFetch(): boolean {
  return process.env.OPENLEAF_ALLOW_PRIVATE_FETCH === "1";
}

/** True if the address is private, loopback, or link-local (IPv4 or IPv6). */
export function isPrivateOrLocalIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split(".").map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = parts as [number, number, number, number];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    if (lower.startsWith("fe80:")) return true;
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.slice("::ffff:".length);
      if (isIP(mapped) === 4) return isPrivateOrLocalIp(mapped);
    }
    return false;
  }
  return true;
}

export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw httpError(400, "Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw httpError(400, "Only http(s) URLs are allowed");
  }
  if (url.username || url.password) {
    throw httpError(400, "URLs with credentials are not allowed");
  }
  const host = url.hostname;
  if (!host) throw httpError(400, "URL has no host");

  if (allowPrivateFetch()) return url;

  if (isIP(host)) {
    if (isPrivateOrLocalIp(host)) {
      throw httpError(400, "Refusing to fetch private or local address");
    }
    return url;
  }

  let records: { address: string; family: number }[] = [];
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw httpError(400, `Could not resolve host ${host}`);
  }
  if (!records.length) throw httpError(400, `Could not resolve host ${host}`);
  for (const rec of records) {
    if (isPrivateOrLocalIp(rec.address)) {
      throw httpError(400, `Refusing to fetch private or local address (${rec.address})`);
    }
  }
  return url;
}

async function readBodyWithCap(res: Response, maxBytes: number): Promise<Buffer> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw httpError(502, `Page exceeded the ${maxBytes} byte limit`);
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw httpError(502, `Page exceeded the ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

export type FetchedWebPage = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: Buffer;
  sha256: string;
  bytes: number;
  fetchedAt: string;
};

/**
 * Fetch a URL with manual redirect handling and per-hop safety checks.
 */
export async function fetchWebPage(
  rawUrl: string,
  opts?: { fetchImpl?: typeof fetch; maxBytes?: number; timeoutMs?: number },
): Promise<FetchedWebPage> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const maxBytes = opts?.maxBytes ?? MAX_WEB_BYTES;
  const timeoutMs = opts?.timeoutMs ?? WEB_FETCH_TIMEOUT_MS;

  let current = await assertSafeUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await fetchImpl(current.toString(), {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        "User-Agent": "OpenLeaf/1.0 (library web source fetch)",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw httpError(502, "Redirect without Location");
      if (hop === MAX_REDIRECTS) throw httpError(502, "Too many redirects");
      const next = new URL(loc, current);
      current = await assertSafeUrl(next.toString());
      continue;
    }

    if (!res.ok) throw httpError(502, `Fetch failed (${res.status})`);
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw httpError(502, `Page exceeded the ${maxBytes} byte limit`);
    }
    const body = await readBodyWithCap(res, maxBytes);
    const sha256 = createHash("sha256").update(body).digest("hex");
    return {
      url: rawUrl,
      finalUrl: current.toString(),
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body,
      sha256,
      bytes: body.length,
      fetchedAt: new Date().toISOString(),
    };
  }
  throw httpError(502, "Too many redirects");
}
