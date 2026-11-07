/**
 * Per-paper AI-assisted facts stored as papers/<citekey>/facts.json.
 * Highlights are page + character offsets into the PDF text layer (see pdfText.ts).
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getPaper, listAllRecords } from "./index.js";
import { ensureLibraryRoot, factsPath, paperDir } from "./paths.js";
import {
  getPdfTextForPaper,
  highlightDisplayRects,
  highlightsFromPageRect,
  locateQuoteInPages,
  pdfTextCapability,
  tightenHighlightToAnswer,
  type FactDisplayRect,
  type FactHighlight,
  type PdfTextCapability,
} from "./pdfText.js";
import { retrieveFactFromPdf } from "./factRetrieve.js";
import { FACT_KEY_RE, isValidFactKey, uniquifyFactKey } from "./factKey.js";
import { invalidateFactKeyIndex, takenFactKeys } from "./factKeyIndex.js";
import { parseFactValue } from "./factValue.js";

export const FactTypeSchema = z.enum(["statement", "value", "question", "tag"]);
export type FactType = z.infer<typeof FactTypeSchema>;

export const FactStatusSchema = z.enum(["unreviewed", "confirmed", "rejected", "not_found"]);
export type FactStatus = z.infer<typeof FactStatusSchema>;

export const FactCreatedBySchema = z.object({
  kind: z.enum(["human", "agent"]),
  name: z.string().default(""),
});
export type FactCreatedBy = z.infer<typeof FactCreatedBySchema>;

export const FactHighlightSchema = z.object({
  page: z.number().int().positive(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  quote: z.string(),
});

export const PaperFactSchema = z.object({
  id: z.string().min(1),
  citekey: z.string().min(1),
  type: FactTypeSchema,
  /** User prompt: claim, value name, question, or tag label. */
  input: z.string().min(1),
  /**
   * AI answer:
   * - statement: "supported" | "not_supported"
   * - value / question: free text
   * - tag: empty (location only)
   */
  answer: z.string().default(""),
  highlights: z.array(FactHighlightSchema).default([]),
  status: FactStatusSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  /** Stable library-wide key for `\fact{key}`. Lazily assigned on read. */
  key: z.string().regex(FACT_KEY_RE).optional(),
  /** Numeric value used in calculations; null when not numeric. */
  value: z.number().nullable().optional(),
  unit: z.string().default(""),
  createdBy: FactCreatedBySchema.default({ kind: "human", name: "" }),
  sourceKind: z.enum(["pdf", "web"]).default("pdf"),
});

export type PaperFact = z.infer<typeof PaperFactSchema>;

const FactsFileSchema = z.object({
  version: z.literal(1).default(1),
  facts: z.array(PaperFactSchema).default([]),
});

export type FactsFile = z.infer<typeof FactsFileSchema>;

const FactRectSchema = z.object({
  page: z.number().int().positive(),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});

export const CreateFactInputSchema = z.object({
  type: FactTypeSchema,
  input: z.string().min(1).max(4000),
  /** Optional human-supplied answer (used with rect/highlights tagging). */
  answer: z.string().max(8000).optional(),
  /** Human PDF tags — skips AI retrieve and auto-confirms. */
  highlights: z.array(FactHighlightSchema).optional(),
  /** Bounding box on a page; server maps intersecting text → highlights. */
  rect: FactRectSchema.optional(),
  key: z.string().regex(FACT_KEY_RE).optional(),
  value: z.number().nullable().optional(),
  unit: z.string().max(64).optional(),
  createdBy: FactCreatedBySchema.optional(),
  sourceKind: z.enum(["pdf", "web"]).optional(),
});
export type CreateFactInput = z.infer<typeof CreateFactInputSchema>;

export const PatchFactInputSchema = z.object({
  input: z.string().min(1).max(4000).optional(),
  answer: z.string().max(8000).optional(),
  status: z.enum(["confirmed", "rejected", "unreviewed"]).optional(),
  /** Replace highlights (human tag). Empty array = untag. Auto-confirms when non-empty. */
  highlights: z.array(FactHighlightSchema).optional(),
  /** Bounding box → highlights (human tag, auto-confirm). */
  rect: FactRectSchema.optional(),
  /** Clear highlights only; keep status/answer. */
  untag: z.boolean().optional(),
  key: z.string().regex(FACT_KEY_RE).optional(),
  value: z.number().nullable().optional(),
  unit: z.string().max(64).optional(),
  /**
   * Host Confirm that intentionally keeps the fact confirmed after editing
   * answer/value/unit/highlights in the same request.
   */
  confirmWithContent: z.boolean().optional(),
});
export type PatchFactInput = z.infer<typeof PatchFactInputSchema>;

export type PaperFactView = PaperFact & {
  displayRects: FactDisplayRect[];
};

export type LibraryFactView = PaperFactView & {
  paperTitle: string;
};

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function newId(): string {
  return `fact_${randomBytes(8).toString("hex")}`;
}

const bakWritten = new Set<string>();

async function ensureBakOnce(citekey: string, file: string): Promise<void> {
  if (bakWritten.has(citekey) || !fs.existsSync(file)) return;
  const bak = `${file}.bak`;
  if (fs.existsSync(bak)) {
    bakWritten.add(citekey);
    return;
  }
  await fsPromises.copyFile(file, bak);
  bakWritten.add(citekey);
}

async function migrateFactsInPlace(citekey: string, data: FactsFile): Promise<FactsFile> {
  const taken = await takenFactKeys();
  // Exclude this file's own keys from collision checks while assigning missing ones.
  for (const f of data.facts) {
    if (f.key && isValidFactKey(f.key)) taken.delete(f.key);
  }
  let dirty = false;
  const nextFacts = data.facts.map((f) => {
    let fact = f;
    if (!fact.key || !isValidFactKey(fact.key)) {
      const key = uniquifyFactKey(undefined, fact.input || fact.id, taken);
      taken.add(key);
      fact = { ...fact, key };
      dirty = true;
    } else {
      taken.add(fact.key);
    }
    if (fact.value === undefined) {
      const parsed = parseFactValue(fact.answer ?? "", fact.unit ?? "");
      fact = {
        ...fact,
        value: parsed.value,
        unit: fact.unit || parsed.unit || "",
      };
      dirty = true;
    }
    if (!fact.createdBy) {
      fact = { ...fact, createdBy: { kind: "human", name: "" } };
      dirty = true;
    }
    if (!fact.sourceKind) {
      fact = { ...fact, sourceKind: "pdf" };
      dirty = true;
    }
    return PaperFactSchema.parse(fact);
  });
  const migrated: FactsFile = { version: 1, facts: nextFacts };
  if (dirty) {
    await writeFile(citekey, migrated);
    invalidateFactKeyIndex();
  }
  return migrated;
}

async function readFile(citekey: string): Promise<FactsFile> {
  const file = factsPath(citekey);
  if (!fs.existsSync(file)) return { version: 1, facts: [] };
  try {
    const raw = JSON.parse(await fsPromises.readFile(file, "utf8")) as unknown;
    const parsed = FactsFileSchema.safeParse(raw);
    if (!parsed.success) return { version: 1, facts: [] };
    return migrateFactsInPlace(citekey, parsed.data);
  } catch {
    return { version: 1, facts: [] };
  }
}

async function writeFile(citekey: string, data: FactsFile): Promise<void> {
  ensureLibraryRoot();
  await fsPromises.mkdir(paperDir(citekey), { recursive: true });
  const file = factsPath(citekey);
  await ensureBakOnce(citekey, file);
  await fsPromises.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  invalidateFactKeyIndex();
}

async function withDisplay(citekey: string, fact: PaperFact): Promise<PaperFactView> {
  if (!fact.highlights.length) return { ...fact, displayRects: [] };
  if (fact.sourceKind === "web") {
    // Web facts use char offsets into snapshot.txt; no PDF display rects.
    return { ...fact, displayRects: [] };
  }
  try {
    const cache = await getPdfTextForPaper(citekey);
    return { ...fact, displayRects: highlightDisplayRects(cache.pages, fact.highlights) };
  } catch {
    return { ...fact, displayRects: [] };
  }
}

function applyMatchedHighlights(
  quotes: string[],
  pages: Awaited<ReturnType<typeof getPdfTextForPaper>>["pages"],
  answer?: string,
): { highlights: FactHighlight[]; status: FactStatus } {
  const highlights: FactHighlight[] = [];
  const seen = new Set<string>();
  for (const q of quotes) {
    for (const hit of locateQuoteInPages(pages, q)) {
      const page = pages.find((p) => p.page === hit.page);
      const tight =
        answer && page ? tightenHighlightToAnswer(hit, page, answer) : hit;
      const key = `${tight.page}:${tight.start}:${tight.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      highlights.push(tight);
      // One cell per quote is enough — avoid spraying every table occurrence.
      break;
    }
  }
  if (!highlights.length) return { highlights: [], status: "not_found" };
  return { highlights, status: "unreviewed" };
}

export async function getFactsCapability(
  citekey: string,
): Promise<PdfTextCapability | { ok: true; pages: number; chars: number; kind: "web" } | { ok: false; reason: "no-source" | "no-text"; kind?: "web" }> {
  const { sourceTextCapability } = await import("./sourceText.js");
  const cap = await sourceTextCapability(citekey);
  if (cap.ok) {
    if (cap.kind === "web") return { ok: true, pages: cap.pages, chars: cap.chars, kind: "web" };
    return { ok: true, pages: cap.pages, chars: cap.chars };
  }
  if (cap.kind === "web") return { ok: false, reason: cap.reason, kind: "web" };
  return pdfTextCapability(citekey);
}

export async function listFacts(citekey: string): Promise<PaperFactView[]> {
  await getPaper(citekey);
  const file = await readFile(citekey);
  const sorted = [...file.facts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return Promise.all(sorted.map((f) => withDisplay(citekey, f)));
}

async function resolveHumanHighlights(
  citekey: string,
  opts: { highlights?: FactHighlight[]; rect?: { page: number; x: number; y: number; w: number; h: number } },
): Promise<FactHighlight[]> {
  if (opts.highlights?.length) return opts.highlights;
  if (!opts.rect) return [];
  const cache = await getPdfTextForPaper(citekey);
  const page = cache.pages.find((p) => p.page === opts.rect!.page);
  if (!page) throw httpError(400, `PDF has no page ${opts.rect.page}`);
  const hits = highlightsFromPageRect(page, opts.rect);
  if (!hits.length) {
    throw httpError(400, "No selectable text found in that region");
  }
  return hits;
}

export async function createFact(
  citekey: string,
  input: CreateFactInput,
  deps?: { retrieve?: typeof retrieveFactFromPdf },
): Promise<PaperFactView> {
  const paper = await getPaper(citekey);
  const parsed = CreateFactInputSchema.parse(input);
  const { getSourceText, sourceTextCapability } = await import("./sourceText.js");
  const capability = await sourceTextCapability(citekey);
  if (!capability.ok) {
    throw httpError(
      400,
      capability.reason === "no-source"
        ? paper.source === "web"
          ? "Facts need a saved web snapshot on this source"
          : "Facts need a PDF attached to this paper"
        : paper.source === "web"
          ? "Facts need readable text in the web snapshot"
          : "Facts need a PDF with a selectable text layer",
    );
  }

  const now = new Date().toISOString();
  const humanTag = Boolean(parsed.highlights?.length || parsed.rect);
  const sourceKind = parsed.sourceKind ?? (capability.kind === "web" ? "web" : "pdf");

  let highlights: FactHighlight[] = [];
  let answer = "";
  let status: FactStatus = "unreviewed";

  if (humanTag) {
    if (sourceKind === "web" && parsed.highlights?.length) {
      highlights = parsed.highlights;
    } else {
      highlights = await resolveHumanHighlights(citekey, {
        highlights: parsed.highlights,
        rect: parsed.rect,
      });
    }
    answer = (parsed.answer ?? "").trim();
    if (parsed.type === "tag") answer = "";
    status = "confirmed";
  } else {
    const { pages } = await getSourceText(citekey);
    const retrieve = deps?.retrieve ?? retrieveFactFromPdf;
    const retrieved = await retrieve({
      type: parsed.type,
      input: parsed.input.trim(),
      paperTitle: paper.title,
      pages,
    });
    const matched = applyMatchedHighlights(retrieved.quotes, pages, retrieved.answer);
    highlights = matched.highlights;
    answer = retrieved.answer;
    status = matched.status;
  }

  const taken = await takenFactKeys();
  const key = uniquifyFactKey(parsed.key, parsed.input.trim(), taken);
  const unit = parsed.unit ?? "";
  const parsedVal = parseFactValue(answer, unit);
  const value = parsed.value !== undefined ? parsed.value : parsedVal.value;
  const inferredUnit = parsed.unit ?? parsedVal.unit;
  const fact = PaperFactSchema.parse({
    id: newId(),
    citekey,
    type: parsed.type,
    input: parsed.input.trim(),
    answer,
    highlights,
    status,
    createdAt: now,
    updatedAt: now,
    key,
    value,
    unit: inferredUnit,
    createdBy: parsed.createdBy ?? { kind: "human", name: "" },
    sourceKind,
  });
  const file = await readFile(citekey);
  file.facts.push(fact);
  await writeFile(citekey, file);
  return withDisplay(citekey, fact);
}

export async function updateFact(
  citekey: string,
  id: string,
  patch: PatchFactInput,
  deps?: { retrieve?: typeof retrieveFactFromPdf },
): Promise<PaperFactView> {
  const paper = await getPaper(citekey);
  const parsed = PatchFactInputSchema.parse(patch);
  const file = await readFile(citekey);
  const idx = file.facts.findIndex((f) => f.id === id);
  if (idx < 0) throw httpError(404, `Fact not found: ${id}`);
  const prev = file.facts[idx]!;

  let next: PaperFact = { ...prev, updatedAt: new Date().toISOString() };
  const humanRetag = Boolean(parsed.rect) || parsed.highlights !== undefined;
  const explicitUntag = parsed.untag === true;
  const keepConfirmed = parsed.confirmWithContent === true && parsed.status === "confirmed";

  // Field writes first (may combine with a tag/untag in the same patch).
  if (parsed.input !== undefined) next = { ...next, input: parsed.input.trim() };
  if (parsed.answer !== undefined) next = { ...next, answer: parsed.answer };
  if (parsed.unit !== undefined) next = { ...next, unit: parsed.unit };
  if (parsed.value !== undefined) next = { ...next, value: parsed.value };
  else if (parsed.answer !== undefined && parsed.answer !== prev.answer) {
    const parsedVal = parseFactValue(parsed.answer, next.unit ?? "");
    next = { ...next, value: parsedVal.value, unit: next.unit || parsedVal.unit };
  }
  if (parsed.key !== undefined && parsed.key !== prev.key) {
    const taken = await takenFactKeys();
    if (prev.key) taken.delete(prev.key);
    if (taken.has(parsed.key)) throw httpError(409, `Fact key already in use: ${parsed.key}`);
    next = { ...next, key: parsed.key };
  }

  if (explicitUntag) {
    next = { ...next, highlights: [] };
  } else if (humanRetag) {
    const highlights = await resolveHumanHighlights(citekey, {
      highlights: parsed.highlights,
      rect: parsed.rect,
    });
    next = {
      ...next,
      highlights,
      status: highlights.length
        ? "confirmed"
        : prev.status === "not_found"
          ? "unreviewed"
          : prev.status,
    };
  } else if (parsed.input !== undefined && parsed.input.trim() !== prev.input) {
    next = { ...next, status: "unreviewed" };
    const capability = await pdfTextCapability(citekey);
    if (!capability.ok) {
      next = { ...next, highlights: [], answer: "", status: "not_found" };
    } else {
      const cache = await getPdfTextForPaper(citekey);
      const retrieve = deps?.retrieve ?? retrieveFactFromPdf;
      const retrieved = await retrieve({
        type: prev.type,
        input: next.input,
        paperTitle: paper.title,
        pages: cache.pages,
      });
      const matched = applyMatchedHighlights(retrieved.quotes, cache.pages, retrieved.answer);
      const parsedVal = parseFactValue(retrieved.answer, next.unit ?? "");
      next = {
        ...next,
        answer: retrieved.answer,
        highlights: matched.highlights,
        status: matched.status,
        value: parsedVal.value,
        unit: next.unit || parsedVal.unit,
      };
    }
  } else if (
    !keepConfirmed &&
    ((parsed.answer !== undefined && parsed.answer !== prev.answer) ||
      (parsed.value !== undefined && parsed.value !== prev.value) ||
      (parsed.unit !== undefined && parsed.unit !== prev.unit) ||
      (humanRetag && parsed.highlights !== undefined))
  ) {
    if (prev.status === "confirmed") next = { ...next, status: "unreviewed" };
  } else if (parsed.status !== undefined) {
    if (prev.status === "not_found" && parsed.status !== "unreviewed") {
      throw httpError(400, "A not-found fact cannot be confirmed or rejected");
    }
    next = { ...next, status: parsed.status };
  }

  if (keepConfirmed) next = { ...next, status: "confirmed" };

  file.facts[idx] = PaperFactSchema.parse(next);
  await writeFile(citekey, file);
  return withDisplay(citekey, file.facts[idx]!);
}

export async function deleteFact(citekey: string, id: string): Promise<void> {
  await getPaper(citekey);
  const file = await readFile(citekey);
  const next = file.facts.filter((f) => f.id !== id);
  if (next.length === file.facts.length) throw httpError(404, `Fact not found: ${id}`);
  await writeFile(citekey, { version: 1, facts: next });
}

/** Clear highlights on every fact; leave status / answers intact. Returns untagged count. */
export async function untagAllFacts(citekey: string): Promise<number> {
  await getPaper(citekey);
  const file = await readFile(citekey);
  let n = 0;
  const now = new Date().toISOString();
  for (const fact of file.facts) {
    if (!fact.highlights.length) continue;
    fact.highlights = [];
    fact.updatedAt = now;
    n += 1;
  }
  if (n) await writeFile(citekey, file);
  return n;
}

/** Count facts that still have PDF highlights (tagged). */
export async function countTaggedFacts(
  citekey: string,
  opts?: { includeUntagged?: boolean },
): Promise<number> {
  await getPaper(citekey);
  const file = await readFile(citekey);
  if (opts?.includeUntagged) return file.facts.length;
  return file.facts.filter((f) => f.highlights.length > 0).length;
}

export async function listAllFacts(opts?: {
  citekey?: string;
  type?: FactType;
  status?: FactStatus;
  q?: string;
}): Promise<LibraryFactView[]> {
  const records = await listAllRecords();
  const q = opts?.q?.trim().toLowerCase() ?? "";
  const out: LibraryFactView[] = [];
  for (const paper of records) {
    if (opts?.citekey && paper.citekey !== opts.citekey) continue;
    const file = await readFile(paper.citekey);
    for (const fact of file.facts) {
      if (opts?.type && fact.type !== opts.type) continue;
      if (opts?.status && fact.status !== opts.status) continue;
      if (q) {
        const hay = `${fact.input}\n${fact.answer}\n${fact.key ?? ""}\n${fact.highlights.map((h) => h.quote).join("\n")}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const view = await withDisplay(paper.citekey, fact);
      out.push({ ...view, paperTitle: paper.title });
    }
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

export type FactKeyRewriteHit = {
  projectId: string;
  relativePath: string;
  lineCount: number;
};

function factMacroPattern(key: string): RegExp {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\\\fact\\{${escaped}\\}`, "g");
}

async function walkTexFiles(
  dir: string,
  relative: string,
  out: { relativePath: string; abs: string }[],
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name === ".git" || ent.name === ".openleaf" || ent.name === "node_modules") continue;
    const rel = relative ? `${relative}/${ent.name}` : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) await walkTexFiles(abs, rel, out);
    else if (ent.isFile() && ent.name.toLowerCase().endsWith(".tex")) out.push({ relativePath: rel, abs });
  }
}

async function findFactKeyReferences(oldKey: string): Promise<FactKeyRewriteHit[]> {
  const { getProjectsRootAbs } = await import("../../config.js");
  const root = getProjectsRootAbs();
  const hits: FactKeyRewriteHit[] = [];
  if (!fs.existsSync(root)) return hits;
  const re = factMacroPattern(oldKey);
  const projects = await fsPromises.readdir(root, { withFileTypes: true });
  for (const proj of projects) {
    if (!proj.isDirectory() || proj.name.startsWith(".")) continue;
    const files: { relativePath: string; abs: string }[] = [];
    await walkTexFiles(path.join(root, proj.name), "", files);
    for (const file of files) {
      let text: string;
      try {
        text = await fsPromises.readFile(file.abs, "utf8");
      } catch {
        continue;
      }
      const matches = text.match(re);
      if (!matches?.length) continue;
      hits.push({ projectId: proj.name, relativePath: file.relativePath, lineCount: matches.length });
    }
  }
  return hits;
}

/** Preview `\fact{old}` rewrite targets before renaming a key. */
export async function previewFactKeyRename(
  citekey: string,
  id: string,
  newKey: string,
): Promise<{ oldKey: string; newKey: string; hits: FactKeyRewriteHit[] }> {
  if (!isValidFactKey(newKey)) throw httpError(400, "Invalid fact key");
  const file = await readFile(citekey);
  const fact = file.facts.find((f) => f.id === id);
  if (!fact) throw httpError(404, `Fact not found: ${id}`);
  const oldKey = fact.key;
  if (!oldKey) throw httpError(400, "Fact has no key yet");
  if (oldKey === newKey) return { oldKey, newKey, hits: [] };
  const taken = await takenFactKeys();
  taken.delete(oldKey);
  if (taken.has(newKey)) throw httpError(409, `Fact key already in use: ${newKey}`);
  const hits = await findFactKeyReferences(oldKey);
  return { oldKey, newKey, hits };
}

/** Rename a fact key and optionally rewrite `\fact{old}` → `\fact{new}` across projects. */
export async function renameFactKey(
  citekey: string,
  id: string,
  newKey: string,
  opts?: { rewriteReferences?: boolean },
): Promise<{ fact: PaperFactView; rewritten: FactKeyRewriteHit[] }> {
  const preview = await previewFactKeyRename(citekey, id, newKey);
  const file = await readFile(citekey);
  const idx = file.facts.findIndex((f) => f.id === id);
  if (idx < 0) throw httpError(404, `Fact not found: ${id}`);
  const prev = file.facts[idx]!;
  file.facts[idx] = PaperFactSchema.parse({
    ...prev,
    key: newKey,
    updatedAt: new Date().toISOString(),
  });
  await writeFile(citekey, file);

  const rewritten: FactKeyRewriteHit[] = [];
  if (opts?.rewriteReferences !== false && preview.hits.length) {
    const { getProjectsRootAbs } = await import("../../config.js");
    const root = getProjectsRootAbs();
    const re = factMacroPattern(preview.oldKey);
    const replacement = `\\fact{${newKey}}`;
    for (const hit of preview.hits) {
      const abs = path.join(root, hit.projectId, hit.relativePath);
      const text = await fsPromises.readFile(abs, "utf8");
      const next = text.replace(re, replacement);
      if (next !== text) {
        await fsPromises.writeFile(abs, next, "utf8");
        rewritten.push(hit);
      }
    }
  }
  return { fact: await withDisplay(citekey, file.facts[idx]!), rewritten };
}
