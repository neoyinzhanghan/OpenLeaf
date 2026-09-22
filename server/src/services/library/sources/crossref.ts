import type { CrossrefClient, ResolvedAuthor, ResolvedPaper } from "./types.js";
import { readLookupCache, writeLookupCache } from "./lookupCache.js";

const CROSSREF_BASE = "https://api.crossref.org/works/";

function splitName(name: string): ResolvedAuthor {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { given: "", family: parts[0]! };
  return { given: parts.slice(0, -1).join(" "), family: parts[parts.length - 1]! };
}

function fromCrossrefMessage(msg: Record<string, unknown>): ResolvedPaper | null {
  const titleArr = msg.title as string[] | undefined;
  const title = titleArr?.[0]?.trim();
  if (!title) return null;
  const authorRaw = (msg.author as Array<{ given?: string; family?: string; name?: string }>) ?? [];
  const authors: ResolvedAuthor[] = authorRaw.map((a) => {
    if (a.family) return { given: a.given ?? "", family: a.family };
    if (a.name) return splitName(a.name);
    return { given: a.given ?? "", family: "Unknown" };
  });
  const issued = msg.issued as { "date-parts"?: number[][] } | undefined;
  const year = issued?.["date-parts"]?.[0]?.[0] ?? null;
  const container = (msg["container-title"] as string[] | undefined)?.[0] ?? "";
  const doi = typeof msg.DOI === "string" ? msg.DOI : null;
  const abstractHtml = typeof msg.abstract === "string" ? msg.abstract : "";
  const abstract = abstractHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return {
    doi,
    arxivId: null,
    title,
    authors,
    venue: container,
    year,
    abstract,
    source: "doi",
    raw: msg,
  };
}

export function createCrossrefClient(opts?: {
  fetchImpl?: typeof fetch;
  mailto?: string;
}): CrossrefClient {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const mailto = opts?.mailto ?? "openleaf@localhost";

  return {
    async lookupDoi(doi: string): Promise<ResolvedPaper | null> {
      const normalized = doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
      if (!normalized) return null;
      const cached = await readLookupCache<ResolvedPaper>("doi", normalized);
      if (cached) return cached;

      const url = `${CROSSREF_BASE}${encodeURIComponent(normalized)}?mailto=${encodeURIComponent(mailto)}`;
      const res = await fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": `OpenLeaf/1.0 (mailto:${mailto})` },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw Object.assign(new Error(`Crossref HTTP ${res.status}`), { status: 502 });
      const body = (await res.json()) as { message?: Record<string, unknown> };
      if (!body.message) return null;
      const paper = fromCrossrefMessage(body.message);
      if (paper) await writeLookupCache("doi", normalized, paper);
      return paper;
    },
  };
}
