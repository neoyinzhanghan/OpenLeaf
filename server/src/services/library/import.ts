/**
 * Import / lookup flows — link paste, PDF drop, bulk .bib.
 * All paths go through addPaper() so DOI dedup stays centralized.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { bibEntryToCreateInput, parseBibtex } from "./bibtex.js";
import { addPaper, findByDoi, getPaper } from "./index.js";
import { paperDir } from "./paths.js";
import { getSourceClients, type ResolvedPaper } from "./sources/index.js";
import { normalizeArxivId } from "./sources/arxiv.js";
import type { CreatePaperInput, PaperRecord } from "./types.js";

export type DetectedLink =
  | { kind: "doi"; value: string }
  | { kind: "arxiv"; value: string }
  | { kind: "pubmed"; value: string }
  | { kind: "url"; value: string };

export function detectLink(input: string): DetectedLink {
  const raw = input.trim();
  // DOI bare or URL
  const doiUrl = raw.match(/^(?:https?:\/\/(?:dx\.)?doi\.org\/)(.+)$/i);
  if (doiUrl) return { kind: "doi", value: doiUrl[1]! };
  if (/^10\.\d{4,}\/\S+$/i.test(raw)) return { kind: "doi", value: raw };

  // arXiv
  if (/arxiv\.org\/(abs|pdf)\//i.test(raw) || /^arxiv:/i.test(raw) || /^\d{4}\.\d{4,5}(v\d+)?$/i.test(raw)) {
    return { kind: "arxiv", value: normalizeArxivId(raw) };
  }

  // PubMed
  const pm = raw.match(/(?:pubmed\.ncbi\.nlm\.nih\.gov\/|pmid:)\s*(\d+)/i);
  if (pm) return { kind: "pubmed", value: pm[1]! };
  if (/^PMID:\s*\d+$/i.test(raw)) return { kind: "pubmed", value: raw.replace(/\D/g, "") };

  if (/^https?:\/\//i.test(raw)) return { kind: "url", value: raw };
  // Fallback: treat as DOI-ish if it looks like one
  if (raw.includes("/") && raw.startsWith("10.")) return { kind: "doi", value: raw };
  return { kind: "url", value: raw };
}

function resolvedToInput(paper: ResolvedPaper, citekey?: string): CreatePaperInput {
  return {
    citekey,
    doi: paper.doi,
    arxivId: paper.arxivId,
    title: paper.title,
    authors: paper.authors,
    venue: paper.venue,
    year: paper.year,
    abstract: paper.abstract,
    source: paper.source,
  };
}

/** Resolve metadata without saving — preview before import. */
export async function lookupExternal(input: {
  doi?: string;
  arxivId?: string;
  title?: string;
  url?: string;
}): Promise<ResolvedPaper | null> {
  const clients = getSourceClients();

  if (input.doi) {
    return (await clients.crossref.lookupDoi(input.doi)) ?? (await clients.openalex.lookupDoi(input.doi));
  }
  if (input.arxivId) {
    return clients.arxiv.lookupId(input.arxivId);
  }
  if (input.url) {
    const detected = detectLink(input.url);
    if (detected.kind === "doi") {
      return (
        (await clients.crossref.lookupDoi(detected.value)) ??
        (await clients.openalex.lookupDoi(detected.value))
      );
    }
    if (detected.kind === "arxiv") {
      return clients.arxiv.lookupId(detected.value);
    }
    // Generic URL: try to scrape a DOI from the page, else fail softly.
    return null;
  }
  if (input.title) {
    return clients.openalex.searchByTitle(input.title);
  }
  return null;
}

export async function importFromLink(
  link: string,
  opts?: { citekey?: string; dryRun?: boolean },
): Promise<{ paper: PaperRecord | ResolvedPaper; created: boolean; existingCitekey?: string }> {
  const detected = detectLink(link);
  let resolved: ResolvedPaper | null = null;

  if (detected.kind === "doi") {
    resolved = await lookupExternal({ doi: detected.value });
  } else if (detected.kind === "arxiv") {
    resolved = await lookupExternal({ arxivId: detected.value });
  } else if (detected.kind === "pubmed") {
    // PubMed IDs: try OpenAlex title-less DOI path via pubmed URL as last resort — skip for now.
    throw Object.assign(new Error("PubMed import requires a DOI — paste the DOI instead"), {
      status: 400,
    });
  } else {
    resolved = await lookupExternal({ url: detected.value });
  }

  if (!resolved) {
    throw Object.assign(new Error("Could not resolve metadata for that link"), { status: 404 });
  }

  if (resolved.doi) {
    const existing = await findByDoi(resolved.doi);
    if (existing) {
      return { paper: existing, created: false, existingCitekey: existing.citekey };
    }
  }

  if (opts?.dryRun) {
    return { paper: resolved, created: false };
  }

  const paper = await addPaper(resolvedToInput(resolved, opts?.citekey));
  return { paper, created: true };
}

export type BibImportResult = {
  imported: PaperRecord[];
  skipped: Array<{ citekey: string; reason: string; existingCitekey?: string }>;
  errors: Array<{ citekey: string; error: string }>;
};

export async function importBibtex(text: string): Promise<BibImportResult> {
  const entries = parseBibtex(text);
  const imported: PaperRecord[] = [];
  const skipped: BibImportResult["skipped"] = [];
  const errors: BibImportResult["errors"] = [];

  for (const entry of entries) {
    try {
      const input = bibEntryToCreateInput(entry);
      if (input.doi) {
        const existing = await findByDoi(input.doi);
        if (existing) {
          skipped.push({
            citekey: entry.citekey,
            reason: "doi-exists",
            existingCitekey: existing.citekey,
          });
          continue;
        }
      }
      try {
        await getPaper(entry.citekey);
        skipped.push({ citekey: entry.citekey, reason: "citekey-exists", existingCitekey: entry.citekey });
        continue;
      } catch {
        /* not found — ok */
      }
      const paper = await addPaper(input);
      imported.push(paper);
    } catch (err) {
      errors.push({
        citekey: entry.citekey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { imported, skipped, errors };
}

/** Best-effort PDF Info dictionary title extraction (no native deps). */
export function extractPdfTitle(buffer: Buffer): string | null {
  const latin = buffer.toString("latin1");
  const titleMatch = latin.match(/\/Title\s*\(([^\)]{1,500})\)/);
  if (titleMatch) {
    return titleMatch[1]!
      .replace(/\\n/g, " ")
      .replace(/\\([()\\])/g, "$1")
      .trim();
  }
  const hexTitle = latin.match(/\/Title\s*<([0-9A-Fa-f]+)>/);
  if (hexTitle) {
    try {
      return Buffer.from(hexTitle[1]!, "hex").toString("utf8").replace(/\0/g, "").trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function importPdf(
  buffer: Buffer,
  opts?: { filename?: string; titleHint?: string; citekey?: string },
): Promise<{ paper: PaperRecord; created: boolean; resolvedVia: string }> {
  const clients = getSourceClients();
  const embeddedTitle = extractPdfTitle(buffer);
  const title = (opts?.titleHint || embeddedTitle || opts?.filename?.replace(/\.pdf$/i, "") || "").trim();
  if (!title) {
    throw Object.assign(new Error("Could not determine a title from the PDF — provide titleHint"), {
      status: 400,
    });
  }

  let resolved =
    (await clients.openalex.searchByTitle(title)) ??
    null;
  // Prefer Crossref if we got a DOI
  if (resolved?.doi) {
    const cr = await clients.crossref.lookupDoi(resolved.doi);
    if (cr) resolved = cr;
  }

  const input: CreatePaperInput = resolved
    ? resolvedToInput({ ...resolved, source: "pdf-upload" }, opts?.citekey)
    : {
        citekey: opts?.citekey,
        title,
        source: "pdf-upload",
        authors: [],
      };

  if (input.doi) {
    const existing = await findByDoi(input.doi);
    if (existing) {
      // Attach PDF to existing record if missing.
      if (!existing.attachment) {
        await saveAttachment(existing.citekey, buffer);
        const updated = await getPaper(existing.citekey);
        return { paper: updated, created: false, resolvedVia: "doi-exists" };
      }
      return { paper: existing, created: false, resolvedVia: "doi-exists" };
    }
  }

  const paper = await addPaper(input);
  await saveAttachment(paper.citekey, buffer);
  const withAttach = await getPaper(paper.citekey);
  return {
    paper: withAttach,
    created: true,
    resolvedVia: resolved ? "openalex-title" : "manual-title",
  };
}

async function saveAttachment(citekey: string, buffer: Buffer): Promise<void> {
  const dir = paperDir(citekey);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "attachment.pdf"), buffer);
  const { updatePaper } = await import("./index.js");
  await updatePaper(citekey, { attachment: "attachment.pdf" });
}
