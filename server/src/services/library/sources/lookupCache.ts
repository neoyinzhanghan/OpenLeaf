/**
 * Cache every external lookup by DOI / arXiv id under library/.cache/lookups/.
 * Keyed so repeated projects citing the same paper do not re-hit external APIs.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { lookupsDir } from "../paths.js";

function sanitizeKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .replace(/^arxiv:/, "")
    .replace(/[^a-z0-9._-]+/g, "_")
    .slice(0, 180);
}

export function lookupCachePath(kind: "doi" | "arxiv" | "title", key: string): string {
  // Sanitizing (lowercasing, collapsing punctuation to "_", truncating to
  // 180 chars) can map two distinct keys to the same string, which would
  // otherwise make them silently share (and overwrite) one cache file. A
  // short hash of the original, un-sanitized key makes the filename unique
  // per key while keeping it human-scannable.
  const digest = crypto.createHash("sha1").update(key.trim().toLowerCase()).digest("hex").slice(0, 10);
  return path.join(lookupsDir(), `${kind}-${sanitizeKey(key)}-${digest}.json`);
}

export async function readLookupCache<T>(
  kind: "doi" | "arxiv" | "title",
  key: string,
  maxAgeMs = 30 * 24 * 60 * 60 * 1000,
): Promise<T | null> {
  const file = lookupCachePath(kind, key);
  if (!fs.existsSync(file)) return null;
  try {
    const stat = await fsPromises.stat(file);
    if (Date.now() - stat.mtimeMs > maxAgeMs) return null;
    const raw = JSON.parse(await fsPromises.readFile(file, "utf8")) as { data: T };
    return raw.data ?? null;
  } catch {
    return null;
  }
}

export async function writeLookupCache(
  kind: "doi" | "arxiv" | "title",
  key: string,
  data: unknown,
): Promise<void> {
  fs.mkdirSync(lookupsDir(), { recursive: true });
  const file = lookupCachePath(kind, key);
  await fsPromises.writeFile(
    file,
    `${JSON.stringify({ cachedAt: new Date().toISOString(), data }, null, 2)}\n`,
    "utf8",
  );
}
