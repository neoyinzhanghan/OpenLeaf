/**
 * Cache every external lookup by DOI / arXiv id under library/.cache/lookups/.
 * Keyed so repeated projects citing the same paper do not re-hit external APIs.
 */
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
  return path.join(lookupsDir(), `${kind}-${sanitizeKey(key)}.json`);
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
