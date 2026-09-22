/**
 * Re-enrich library papers from Crossref / OpenAlex / arXiv, then integrity-check.
 * Library records should not stay as BibTeX stubs when an internet identifier exists.
 */
import { findByDoi, getPaper, listAllRecords, updatePaper } from "./index.js";
import { lookupExternal } from "./import.js";
import { checkPaperIntegrity, type IntegrityCheckResult } from "./integrity.js";
import type { PaperRecord } from "./types.js";

export type EnrichResult = {
  citekey: string;
  enriched: boolean;
  reason?: string;
  paper: PaperRecord;
  integrity?: IntegrityCheckResult;
};

function needsEnrichment(paper: PaperRecord, force: boolean): boolean {
  if (force) return true;
  if (paper.title === paper.citekey) return true;
  if (/Imported as stub|metadata copied|enrich via/i.test(paper.notes ?? "")) return true;
  if (paper.authors.length === 0) return true;
  if (paper.integrity.existence === "unresolved" || !paper.integrity.lastChecked) return true;
  // BibTeX-only imports without a verified DOI/arXiv identity still deserve a live lookup.
  if (
    (paper.source === "bibtex-import" || paper.source === "manual") &&
    paper.integrity.existence !== "verified"
  ) {
    return true;
  }
  return false;
}

async function resolveForPaper(paper: PaperRecord) {
  if (paper.doi) {
    const byDoi = await lookupExternal({ doi: paper.doi });
    if (byDoi) return byDoi;
  }
  if (paper.arxivId) {
    const byArxiv = await lookupExternal({ arxivId: paper.arxivId });
    if (byArxiv) return byArxiv;
  }
  if (paper.title && paper.title !== paper.citekey) {
    return lookupExternal({ title: paper.title });
  }
  return null;
}

/** Pull live metadata for one paper and optionally run an integrity check. */
export async function enrichPaper(
  citekey: string,
  opts?: { force?: boolean; checkIntegrity?: boolean; fetchImpl?: typeof fetch },
): Promise<EnrichResult> {
  const paper = await getPaper(citekey);
  const force = Boolean(opts?.force);
  if (!needsEnrichment(paper, force)) {
    let integrity: IntegrityCheckResult | undefined;
    if (opts?.checkIntegrity !== false && (!paper.integrity.lastChecked || force)) {
      integrity = await checkPaperIntegrity(citekey, { force: true, fetchImpl: opts?.fetchImpl });
    }
    return {
      citekey,
      enriched: false,
      reason: "already-enriched",
      paper: integrity ? await getPaper(citekey) : paper,
      integrity,
    };
  }

  const resolved = await resolveForPaper(paper);
  if (!resolved) {
    let integrity: IntegrityCheckResult | undefined;
    if (opts?.checkIntegrity !== false) {
      integrity = await checkPaperIntegrity(citekey, { force: true, fetchImpl: opts?.fetchImpl });
    }
    return {
      citekey,
      enriched: false,
      reason: "no-external-match",
      paper: integrity ? await getPaper(citekey) : paper,
      integrity,
    };
  }

  let doi = resolved.doi ?? paper.doi ?? null;
  if (doi) {
    const owner = await findByDoi(doi);
    if (owner && owner.citekey !== citekey) {
      // Keep this project's citekey; leave DOI on the canonical record.
      doi = paper.doi && paper.doi.toLowerCase() !== doi.toLowerCase() ? paper.doi : null;
    }
  }

  let arxivId = resolved.arxivId ?? paper.arxivId ?? null;
  const arxivFromDoi = (doi ?? paper.doi ?? "").match(/^10\.48550\/arxiv\.(.+)$/i)?.[1];
  if (!arxivId && arxivFromDoi) arxivId = arxivFromDoi;

  const cleanedNotes = (paper.notes ?? "")
    .replace(/Imported as stub from project \\cite\{\}; enrich via Library lookup\.?/gi, "")
    .replace(/Project citekey alias of \S+; metadata copied\.?/gi, "")
    .trim();

  await updatePaper(citekey, {
    title: resolved.title || paper.title,
    authors: resolved.authors.length ? resolved.authors : paper.authors,
    venue: resolved.venue || paper.venue,
    year: resolved.year ?? paper.year,
    abstract: resolved.abstract || paper.abstract,
    doi,
    arxivId,
    source: resolved.source,
    notes: cleanedNotes,
  });

  let integrity: IntegrityCheckResult | undefined;
  if (opts?.checkIntegrity !== false) {
    integrity = await checkPaperIntegrity(citekey, { force: true, fetchImpl: opts?.fetchImpl });
  }

  return {
    citekey,
    enriched: true,
    paper: await getPaper(citekey),
    integrity,
  };
}

export async function enrichLibrary(opts?: {
  force?: boolean;
  citekeys?: string[];
  checkIntegrity?: boolean;
  delayMs?: number;
  onProgress?: (done: number, total: number, result: EnrichResult) => void;
}): Promise<EnrichResult[]> {
  const all = await listAllRecords();
  const targets = opts?.citekeys?.length
    ? all.filter((p) => opts.citekeys!.includes(p.citekey))
    : all;
  const delayMs = opts?.delayMs ?? 250;
  const results: EnrichResult[] = [];
  for (let i = 0; i < targets.length; i++) {
    const paper = targets[i]!;
    try {
      const result = await enrichPaper(paper.citekey, {
        force: opts?.force,
        checkIntegrity: opts?.checkIntegrity,
      });
      results.push(result);
      opts?.onProgress?.(i + 1, targets.length, result);
    } catch (err) {
      const failed: EnrichResult = {
        citekey: paper.citekey,
        enriched: false,
        reason: err instanceof Error ? err.message : String(err),
        paper,
      };
      results.push(failed);
      opts?.onProgress?.(i + 1, targets.length, failed);
    }
    if (delayMs > 0 && i + 1 < targets.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return results;
}
