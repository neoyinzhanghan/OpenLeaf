/**
 * Local duplicate detection — DOI, arXiv id, and soft title (+ first author) match.
 */
import { normalizeArxivId } from "./sources/arxiv.js";
import type { PaperAuthor, PaperRecord } from "./types.js";

export type DuplicateKind = "doi" | "arxiv" | "title";

export type DuplicateMatch = {
  paper: PaperRecord;
  match: DuplicateKind;
};

export function normalizeTitleForMatch(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * First-author families. Exact match, or a compound surname whose last word
 * is the other family ("El Nahhas" / "Nahhas"). Short names stay exact so
 * "Li" does not match "Liang".
 */
export function authorFamiliesCompatible(a: string, b: string): boolean {
  const na = a.trim().toLowerCase().replace(/\s+/g, " ");
  const nb = b.trim().toLowerCase().replace(/\s+/g, " ");
  if (!na || !nb) return true;
  if (na === nb) return true;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (shorter.length < 5) return false;
  if (!longer.endsWith(shorter)) return false;
  const boundary = longer[longer.length - shorter.length - 1];
  return boundary === " " || boundary === "-";
}

/** Soft title match: exact normalized equality or containment of the first 40 chars. */
export function titlesSoftMatch(a: string, b: string): boolean {
  const la = normalizeTitleForMatch(a);
  const lb = normalizeTitleForMatch(b);
  if (!la || !lb) return false;
  if (la === lb) return true;
  const a40 = la.slice(0, 40);
  const b40 = lb.slice(0, 40);
  if (a40.length < 12 || b40.length < 12) return false;
  return la.includes(b40) || lb.includes(a40);
}

function normalizeArxivKey(id: string): string {
  return normalizeArxivId(id)
    .toLowerCase()
    .replace(/v\d+$/i, "");
}

export async function findByArxiv(arxivId: string): Promise<PaperRecord | null> {
  const { listAllRecords } = await import("./index.js");
  const normalized = normalizeArxivKey(arxivId);
  if (!normalized) return null;
  const all = await listAllRecords();
  return (
    all.find((r) => r.arxivId && normalizeArxivKey(r.arxivId) === normalized) ?? null
  );
}

export async function findLikelyDuplicate(
  input: {
    doi?: string | null;
    arxivId?: string | null;
    title?: string | null;
    authors?: PaperAuthor[] | null;
  },
  records?: PaperRecord[],
): Promise<DuplicateMatch | null> {
  const { findByDoi, listAllRecords } = await import("./index.js");
  const pool = records ?? (await listAllRecords());
  if (input.doi?.trim()) {
    const byDoi = await findByDoi(input.doi, pool);
    if (byDoi) return { paper: byDoi, match: "doi" };
  }
  if (input.arxivId?.trim()) {
    const normalized = normalizeArxivKey(input.arxivId);
    const byArxiv = normalized
      ? (pool.find((r) => r.arxivId && normalizeArxivKey(r.arxivId) === normalized) ?? null)
      : null;
    if (byArxiv) return { paper: byArxiv, match: "arxiv" };
  }
  const title = input.title?.trim();
  if (!title) return null;

  const family = input.authors?.[0]?.family?.trim().toLowerCase() ?? "";
  const all = pool;
  for (const r of all) {
    if (!titlesSoftMatch(title, r.title)) continue;
    if (family) {
      const other = r.authors[0]?.family?.trim() ?? "";
      if (other && !authorFamiliesCompatible(family, other)) continue;
    }
    return { paper: r, match: "title" };
  }
  return null;
}
