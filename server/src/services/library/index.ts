import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import {
  closeIndexDb,
  rebuildIndex,
  removePaperFromIndex,
  searchIndex,
  upsertPaperInIndex,
} from "./indexDb.js";
import {
  collectionsPath,
  ensureLibraryRoot,
  paperDir,
  papersDir,
  recordPath,
} from "./paths.js";
import {
  CollectionsFileSchema,
  CreatePaperInputSchema,
  PaperRecordSchema,
  PatchPaperInputSchema,
  type CollectionsFile,
  type CreatePaperInput,
  type LibrarySearchOpts,
  type PaperRecord,
  type PatchPaperInput,
} from "./types.js";

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function slugifyCitekey(title: string, year: number | null | undefined): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  const base = words.join("") || "paper";
  const y = year ?? new Date().getFullYear();
  return `${base}${y}`.slice(0, 64);
}

function authorsFamilyLead(authors: PaperRecord["authors"]): string {
  const family = authors[0]?.family?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
  return family || "anon";
}

/** Prefer family+year+firstTitleWord when generating a citekey. */
export function suggestCitekey(input: {
  title: string;
  authors?: PaperRecord["authors"];
  year?: number | null;
}): string {
  const family = authorsFamilyLead(input.authors ?? []);
  const year = input.year ?? new Date().getFullYear();
  const word =
    input.title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .find(Boolean) ?? "paper";
  return `${family}${year}${word}`.slice(0, 64);
}

async function readRecordFile(citekey: string): Promise<PaperRecord | null> {
  const file = recordPath(citekey);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(await fsPromises.readFile(file, "utf8")) as unknown;
    const parsed = PaperRecordSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeRecordFile(record: PaperRecord): Promise<void> {
  const dir = paperDir(record.citekey);
  await fsPromises.mkdir(dir, { recursive: true });
  const file = recordPath(record.citekey);
  await fsPromises.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/** Scan papers/<citekey>/record.json — the filesystem is the product. */
export async function listAllRecords(): Promise<PaperRecord[]> {
  ensureLibraryRoot();
  const root = papersDir();
  if (!fs.existsSync(root)) return [];
  const entries = await fsPromises.readdir(root, { withFileTypes: true });
  const out: PaperRecord[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const record = await readRecordFile(ent.name);
    if (record) out.push(record);
  }
  out.sort((a, b) => a.citekey.localeCompare(b.citekey));
  return out;
}

export async function getPaper(citekey: string): Promise<PaperRecord> {
  ensureLibraryRoot();
  const record = await readRecordFile(citekey);
  if (!record) throw httpError(404, `Paper not found: ${citekey}`);
  return record;
}

export async function findByDoi(doi: string): Promise<PaperRecord | null> {
  const normalized = doi.trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  if (!normalized) return null;
  const all = await listAllRecords();
  return all.find((r) => r.doi?.toLowerCase() === normalized) ?? null;
}

export async function searchPapers(opts: LibrarySearchOpts = {}): Promise<PaperRecord[]> {
  ensureLibraryRoot();
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  let candidates: PaperRecord[];

  if (opts.q?.trim()) {
    const citekeys = searchIndex(opts.q, limit * 2);
    if (citekeys === null) {
      candidates = await listAllRecords();
    } else if (citekeys.length === 0) {
      // FTS miss: fall back to simple substring over records (tiny libraries).
      const all = await listAllRecords();
      const needle = opts.q.trim().toLowerCase();
      candidates = all.filter(
        (r) =>
          r.citekey.toLowerCase().includes(needle) ||
          r.title.toLowerCase().includes(needle) ||
          r.abstract.toLowerCase().includes(needle) ||
          r.notes.toLowerCase().includes(needle) ||
          r.tags.some((t) => t.toLowerCase().includes(needle)) ||
          r.authors.some((a) => `${a.given} ${a.family}`.toLowerCase().includes(needle)),
      );
    } else {
      const byKey = new Map<string, PaperRecord>();
      for (const key of citekeys) {
        const rec = await readRecordFile(key);
        if (rec) byKey.set(key, rec);
      }
      candidates = citekeys.map((k) => byKey.get(k)).filter((r): r is PaperRecord => !!r);
    }
  } else {
    candidates = await listAllRecords();
  }

  if (opts.tag) {
    const tag = opts.tag.toLowerCase();
    candidates = candidates.filter((r) => r.tags.some((t) => t.toLowerCase() === tag));
  }
  if (opts.collection) {
    const coll = opts.collection.toLowerCase();
    candidates = candidates.filter((r) =>
      r.collections.some((c) => c.toLowerCase() === coll),
    );
  }
  return candidates.slice(0, limit);
}

export async function addPaper(input: CreatePaperInput): Promise<PaperRecord> {
  ensureLibraryRoot();
  const parsed = CreatePaperInputSchema.parse(input);

  if (parsed.doi) {
    const existing = await findByDoi(parsed.doi);
    if (existing) throw httpError(409, `Paper with DOI already exists: ${existing.citekey}`);
  }

  let citekey = parsed.citekey ?? suggestCitekey(parsed);
  if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(citekey)) {
    citekey = slugifyCitekey(parsed.title, parsed.year);
  }
  // Dedup citekey collisions by suffixing -2, -3, …
  let candidate = citekey;
  let n = 2;
  while (fs.existsSync(recordPath(candidate))) {
    candidate = `${citekey}-${n}`;
    n += 1;
  }
  citekey = candidate;

  const now = new Date().toISOString();
  const record = PaperRecordSchema.parse({
    citekey,
    doi: parsed.doi ?? null,
    arxivId: parsed.arxivId ?? null,
    title: parsed.title,
    authors: parsed.authors ?? [],
    venue: parsed.venue ?? "",
    year: parsed.year ?? null,
    abstract: parsed.abstract ?? "",
    tags: parsed.tags ?? [],
    collections: parsed.collections ?? [],
    notes: parsed.notes ?? "",
    attachment: parsed.attachment ?? null,
    source: parsed.source ?? "manual",
    integrity: { existence: "unresolved", retraction: "clean", lastChecked: null },
    addedAt: now,
  });

  await writeRecordFile(record);
  upsertPaperInIndex(record);
  return record;
}

export async function updatePaper(citekey: string, patch: PatchPaperInput): Promise<PaperRecord> {
  ensureLibraryRoot();
  const existing = await getPaper(citekey);
  const parsed = PatchPaperInputSchema.parse(patch);

  // Citekey rename: move directory.
  const nextCitekey = parsed.citekey && parsed.citekey !== citekey ? parsed.citekey : citekey;
  if (nextCitekey !== citekey) {
    if (fs.existsSync(recordPath(nextCitekey))) {
      throw httpError(409, `Citekey already exists: ${nextCitekey}`);
    }
  }

  if (parsed.doi && parsed.doi !== existing.doi) {
    const clash = await findByDoi(parsed.doi);
    if (clash && clash.citekey !== citekey) {
      throw httpError(409, `Paper with DOI already exists: ${clash.citekey}`);
    }
  }

  const updated = PaperRecordSchema.parse({
    citekey: nextCitekey,
    doi: parsed.doi !== undefined ? parsed.doi : existing.doi,
    arxivId: parsed.arxivId !== undefined ? parsed.arxivId : existing.arxivId,
    title: parsed.title ?? existing.title,
    authors: parsed.authors ?? existing.authors,
    venue: parsed.venue ?? existing.venue,
    year: parsed.year !== undefined ? parsed.year : existing.year,
    abstract: parsed.abstract ?? existing.abstract,
    tags: parsed.tags ?? existing.tags,
    collections: parsed.collections ?? existing.collections,
    notes: parsed.notes ?? existing.notes,
    attachment: parsed.attachment !== undefined ? parsed.attachment : existing.attachment,
    source: parsed.source ?? existing.source,
    integrity: existing.integrity,
    addedAt: existing.addedAt,
  });

  if (nextCitekey !== citekey) {
    await fsPromises.rename(paperDir(citekey), paperDir(nextCitekey));
    removePaperFromIndex(citekey);
  }
  await writeRecordFile(updated);
  upsertPaperInIndex(updated);
  return updated;
}

export async function deletePaper(citekey: string): Promise<void> {
  ensureLibraryRoot();
  const dir = paperDir(citekey);
  if (!fs.existsSync(dir)) throw httpError(404, `Paper not found: ${citekey}`);
  await fsPromises.rm(dir, { recursive: true, force: true });
  removePaperFromIndex(citekey);
}

export async function readCollections(): Promise<CollectionsFile> {
  ensureLibraryRoot();
  const file = collectionsPath();
  try {
    const raw = JSON.parse(await fsPromises.readFile(file, "utf8")) as unknown;
    const parsed = CollectionsFileSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
  } catch {
    /* fall through */
  }
  return { version: 1, collections: {} };
}

export async function writeCollections(data: CollectionsFile): Promise<CollectionsFile> {
  ensureLibraryRoot();
  const parsed = CollectionsFileSchema.parse(data);
  await fsPromises.writeFile(
    collectionsPath(),
    `${JSON.stringify(parsed, null, 2)}\n`,
    "utf8",
  );
  return parsed;
}

export async function upsertCollection(id: string, name: string): Promise<CollectionsFile> {
  const current = await readCollections();
  current.collections[id] = {
    name,
    createdAt: current.collections[id]?.createdAt ?? new Date().toISOString(),
  };
  return writeCollections(current);
}

export async function deleteCollection(id: string): Promise<CollectionsFile> {
  const current = await readCollections();
  delete current.collections[id];
  // Drop membership from papers.
  const all = await listAllRecords();
  for (const paper of all) {
    if (paper.collections.includes(id)) {
      await updatePaper(paper.citekey, {
        collections: paper.collections.filter((c) => c !== id),
      });
    }
  }
  return writeCollections(current);
}

/** Rebuild FTS from all record.json files (call on boot and after bulk import). */
export async function reindexLibrary(): Promise<{ count: number }> {
  ensureLibraryRoot();
  const records = await listAllRecords();
  rebuildIndex(records);
  return { count: records.length };
}

/** Boot hook: ensure dirs + rebuild FTS from record.json (index is disposable). */
export async function ensureLibraryBoot(): Promise<void> {
  ensureLibraryRoot();
  await reindexLibrary();
}

export { closeIndexDb };
