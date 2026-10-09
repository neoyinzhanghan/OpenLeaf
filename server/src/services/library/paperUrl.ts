/**
 * Canonical landing URL for a library paper.
 * Prefer DOI → arXiv → explicit OpenAlex/landing → Scholar fallback.
 */
import type { PaperRecord } from "./types.js";

export function normalizeDoi(doi: string): string {
  return doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
}

export function doiUrl(doi: string): string {
  return `https://doi.org/${normalizeDoi(doi)}`;
}

export function arxivAbsUrl(arxivId: string): string {
  const id = arxivId
    .trim()
    .replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, "")
    .replace(/\.pdf$/i, "")
    .replace(/^arxiv:/i, "");
  return `https://arxiv.org/abs/${id}`;
}

export function scholarUrl(title: string): string {
  return `https://scholar.google.com/scholar?q=${encodeURIComponent(title.trim())}`;
}

/** Best stable public URL for this paper (always returns a non-empty https URL). */
export function derivePaperUrl(paper: Pick<PaperRecord, "url" | "doi" | "arxivId" | "title"> & {
  notes?: string;
}): string {
  const existing = (paper.url ?? "").trim();
  if (/^https?:\/\//i.test(existing)) return existing;

  if (paper.doi) return doiUrl(paper.doi);

  const arxivFromDoi = (paper.doi ?? "").match(/^10\.48550\/arxiv\.(.+)$/i)?.[1];
  if (paper.arxivId) return arxivAbsUrl(paper.arxivId);
  if (arxivFromDoi) return arxivAbsUrl(arxivFromDoi);

  // Alias notes sometimes point at a peer that owns the DOI; Scholar still works as fallback.
  if (paper.title?.trim()) return scholarUrl(paper.title);
  return "https://scholar.google.com/";
}

/** True when url is missing or not an absolute http(s) link. */
export function needsPaperUrl(paper: Pick<PaperRecord, "url">): boolean {
  return !paper.url || !/^https?:\/\//i.test(paper.url.trim());
}
