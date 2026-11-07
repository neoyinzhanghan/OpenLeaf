/**
 * Library-wide fact key → (citekey, factId) index.
 * Rebuilt from facts.json files; cached by file mtimes. Spec §4.1.
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { libraryRoot, papersDir } from "./paths.js";
import { isValidFactKey } from "./factKey.js";

export type FactKeyEntry = { citekey: string; factId: string; key: string };

type Cache = {
  stamp: string;
  byKey: Map<string, FactKeyEntry>;
  allKeys: Set<string>;
};

let cache: Cache | null = null;

async function scanStamp(): Promise<string> {
  const root = papersDir();
  if (!fs.existsSync(root)) return "empty";
  const parts: string[] = [];
  let dirs: string[] = [];
  try {
    dirs = await fsPromises.readdir(root);
  } catch {
    return "empty";
  }
  for (const citekey of dirs) {
    const file = path.join(root, citekey, "facts.json");
    try {
      const st = await fsPromises.stat(file);
      parts.push(`${citekey}:${st.mtimeMs}:${st.size}`);
    } catch {
      /* no facts file */
    }
  }
  parts.sort();
  return parts.join("|");
}

async function rebuild(): Promise<Cache> {
  const stamp = await scanStamp();
  const byKey = new Map<string, FactKeyEntry>();
  const allKeys = new Set<string>();
  const root = papersDir();
  if (!fs.existsSync(root)) {
    cache = { stamp, byKey, allKeys };
    return cache;
  }
  const dirs = await fsPromises.readdir(root);
  for (const citekey of dirs) {
    const file = path.join(root, citekey, "facts.json");
    let raw: unknown;
    try {
      raw = JSON.parse(await fsPromises.readFile(file, "utf8"));
    } catch {
      continue;
    }
    const facts = (raw as { facts?: unknown })?.facts;
    if (!Array.isArray(facts)) continue;
    for (const f of facts) {
      if (!f || typeof f !== "object") continue;
      const rec = f as { id?: unknown; key?: unknown };
      if (typeof rec.id !== "string" || typeof rec.key !== "string") continue;
      if (!isValidFactKey(rec.key)) continue;
      allKeys.add(rec.key);
      byKey.set(rec.key, { citekey, factId: rec.id, key: rec.key });
    }
  }
  cache = { stamp, byKey, allKeys };
  return cache;
}

export async function getFactKeyIndex(force = false): Promise<Cache> {
  void libraryRoot();
  if (!force && cache) {
    const stamp = await scanStamp();
    if (stamp === cache.stamp) return cache;
  }
  return rebuild();
}

export async function resolveFactKey(key: string): Promise<FactKeyEntry | null> {
  const idx = await getFactKeyIndex();
  return idx.byKey.get(key) ?? null;
}

export async function takenFactKeys(): Promise<Set<string>> {
  const idx = await getFactKeyIndex();
  return new Set(idx.allKeys);
}

/** Drop the cache (tests / after bulk writes). */
export function invalidateFactKeyIndex(): void {
  cache = null;
}
