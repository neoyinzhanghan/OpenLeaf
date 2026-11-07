/**
 * Per-paper AI-assisted facts stored as papers/<citekey>/facts.json.
 * Highlights are page + character offsets into the PDF text layer (see pdfText.ts).
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
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

export const FactTypeSchema = z.enum(["statement", "value", "question", "tag"]);
export type FactType = z.infer<typeof FactTypeSchema>;

export const FactStatusSchema = z.enum(["unreviewed", "confirmed", "rejected", "not_found"]);
export type FactStatus = z.infer<typeof FactStatusSchema>;

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

async function readFile(citekey: string): Promise<FactsFile> {
  const file = factsPath(citekey);
  if (!fs.existsSync(file)) return { version: 1, facts: [] };
  try {
    const raw = JSON.parse(await fsPromises.readFile(file, "utf8")) as unknown;
    const parsed = FactsFileSchema.safeParse(raw);
    return parsed.success ? parsed.data : { version: 1, facts: [] };
  } catch {
    return { version: 1, facts: [] };
  }
}

async function writeFile(citekey: string, data: FactsFile): Promise<void> {
  ensureLibraryRoot();
  await fsPromises.mkdir(paperDir(citekey), { recursive: true });
  await fsPromises.writeFile(factsPath(citekey), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function withDisplay(citekey: string, fact: PaperFact): Promise<PaperFactView> {
  if (!fact.highlights.length) return { ...fact, displayRects: [] };
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

export async function getFactsCapability(citekey: string): Promise<PdfTextCapability> {
  await getPaper(citekey);
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
  const capability = await pdfTextCapability(citekey);
  if (!capability.ok) {
    throw httpError(
      400,
      capability.reason === "no-pdf"
        ? "Facts need a PDF attached to this paper"
        : "Facts need a PDF with a selectable text layer",
    );
  }

  const now = new Date().toISOString();
  const humanTag = Boolean(parsed.highlights?.length || parsed.rect);

  let highlights: FactHighlight[] = [];
  let answer = "";
  let status: FactStatus = "unreviewed";

  if (humanTag) {
    highlights = await resolveHumanHighlights(citekey, {
      highlights: parsed.highlights,
      rect: parsed.rect,
    });
    answer = (parsed.answer ?? "").trim();
    if (parsed.type === "tag") answer = "";
    status = "confirmed";
  } else {
    const cache = await getPdfTextForPaper(citekey);
    const retrieve = deps?.retrieve ?? retrieveFactFromPdf;
    const retrieved = await retrieve({
      type: parsed.type,
      input: parsed.input.trim(),
      paperTitle: paper.title,
      pages: cache.pages,
    });
    const matched = applyMatchedHighlights(retrieved.quotes, cache.pages, retrieved.answer);
    highlights = matched.highlights;
    answer = retrieved.answer;
    status = matched.status;
  }

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

  // Field writes first (may combine with a tag/untag in the same patch).
  if (parsed.input !== undefined) next = { ...next, input: parsed.input.trim() };
  if (parsed.answer !== undefined) next = { ...next, answer: parsed.answer };

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
      next = {
        ...next,
        answer: retrieved.answer,
        highlights: matched.highlights,
        status: matched.status,
      };
    }
  } else if (parsed.answer !== undefined && parsed.answer !== prev.answer) {
    next = { ...next, status: "unreviewed" };
  } else if (parsed.status !== undefined) {
    if (prev.status === "not_found" && parsed.status !== "unreviewed") {
      throw httpError(400, "A not-found fact cannot be confirmed or rejected");
    }
    next = { ...next, status: parsed.status };
  }

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
        const hay = `${fact.input}\n${fact.answer}\n${fact.highlights.map((h) => h.quote).join("\n")}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const view = await withDisplay(paper.citekey, fact);
      out.push({ ...view, paperTitle: paper.title });
    }
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}
