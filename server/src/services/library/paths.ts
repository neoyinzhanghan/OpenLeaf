import fs from "node:fs";
import path from "node:path";
import { getLibraryRootAbs } from "../../config.js";

function pathError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/**
 * Citekeys reach filesystem paths from several trust boundaries (host routes,
 * BibTeX import, the Library-AI bearer surface, MCP tools). Validate the
 * shape here, once, centrally, rather than trusting every caller to have
 * sanitized it first — matches CitekeySchema in ./types.ts, but duplicated
 * as a plain regex to avoid a dependency cycle with zod-based types here.
 * Rejects anything containing "/", "\", or ".." so a crafted citekey (e.g.
 * from a URL param where "%2f" decodes to "/" only after Express routing)
 * cannot escape papersDir().
 */
const SAFE_CITEKEY = /^[A-Za-z][A-Za-z0-9_.:-]*$/;

export function assertSafeCitekey(citekey: string): void {
  if (
    typeof citekey !== "string" ||
    citekey.length === 0 ||
    citekey.length > 128 ||
    citekey.includes("/") ||
    citekey.includes("\\") ||
    citekey.includes("..") ||
    !SAFE_CITEKEY.test(citekey)
  ) {
    throw pathError(400, "Invalid citekey");
  }
}

export function libraryRoot(): string {
  return getLibraryRootAbs();
}

export function papersDir(): string {
  return path.join(libraryRoot(), "papers");
}

export function paperDir(citekey: string): string {
  assertSafeCitekey(citekey);
  return path.join(papersDir(), citekey);
}

export function recordPath(citekey: string): string {
  return path.join(paperDir(citekey), "record.json");
}

export function annotationsPath(citekey: string): string {
  return path.join(paperDir(citekey), "annotations.json");
}

export function attachmentPath(citekey: string): string {
  return path.join(paperDir(citekey), "attachment.pdf");
}

export function collectionsPath(): string {
  return path.join(libraryRoot(), "collections.json");
}

export function cacheDir(): string {
  return path.join(libraryRoot(), ".cache");
}

export function indexDbPath(): string {
  return path.join(cacheDir(), "index.sqlite");
}

export function lookupsDir(): string {
  return path.join(cacheDir(), "lookups");
}

/** Create library root layout if missing (sibling of projects/). */
export function ensureLibraryRoot(): void {
  const root = libraryRoot();
  fs.mkdirSync(path.join(root, "papers"), { recursive: true });
  fs.mkdirSync(path.join(root, ".cache", "lookups"), { recursive: true });
  const coll = collectionsPath();
  if (!fs.existsSync(coll)) {
    fs.writeFileSync(coll, `${JSON.stringify({ version: 1, collections: {} }, null, 2)}\n`, "utf8");
  }
}
