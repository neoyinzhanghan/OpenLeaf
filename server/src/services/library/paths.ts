import fs from "node:fs";
import path from "node:path";
import { getLibraryRootAbs } from "../../config.js";

export function libraryRoot(): string {
  return getLibraryRootAbs();
}

export function papersDir(): string {
  return path.join(libraryRoot(), "papers");
}

export function paperDir(citekey: string): string {
  return path.join(papersDir(), citekey);
}

export function recordPath(citekey: string): string {
  return path.join(paperDir(citekey), "record.json");
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
