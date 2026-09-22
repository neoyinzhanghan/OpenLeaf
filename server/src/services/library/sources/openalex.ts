import type { OpenAlexClient, ResolvedAuthor, ResolvedPaper } from "./types.js";
import { readLookupCache, writeLookupCache } from "./lookupCache.js";

const OPENALEX_BASE = "https://api.openalex.org";

function fromOpenAlexWork(work: Record<string, unknown>): ResolvedPaper | null {
  const title = typeof work.title === "string" ? work.title.trim() : "";
  if (!title) return null;
  const authorships = (work.authorships as Array<{ author?: { display_name?: string } }>) ?? [];
  const authors: ResolvedAuthor[] = authorships.map((a) => {
    const name = a.author?.display_name ?? "Unknown";
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return { given: "", family: parts[0]! };
    return { given: parts.slice(0, -1).join(" "), family: parts[parts.length - 1]! };
  });
  const ids = work.ids as { doi?: string } | undefined;
  let doi: string | null = null;
  if (typeof ids?.doi === "string") {
    doi = ids.doi.replace(/^https?:\/\/doi\.org\//i, "");
  } else if (typeof work.doi === "string") {
    doi = work.doi.replace(/^https?:\/\/doi\.org\//i, "");
  }
  const year = typeof work.publication_year === "number" ? work.publication_year : null;
  const primary = work.primary_location as { source?: { display_name?: string } } | undefined;
  const venue = primary?.source?.display_name ?? "";
  const abstractInverted = work.abstract_inverted_index as Record<string, number[]> | undefined;
  let abstract = "";
  if (abstractInverted) {
    const pairs: Array<[number, string]> = [];
    for (const [word, positions] of Object.entries(abstractInverted)) {
      for (const pos of positions) pairs.push([pos, word]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    abstract = pairs.map((p) => p[1]).join(" ");
  }
  return {
    doi,
    arxivId: null,
    title,
    authors,
    venue,
    year,
    abstract,
    source: doi ? "doi" : "manual",
    raw: work,
  };
}

export function createOpenAlexClient(opts?: {
  fetchImpl?: typeof fetch;
  mailto?: string;
}): OpenAlexClient {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const mailto = opts?.mailto ?? "openleaf@localhost";

  async function getJson(url: string): Promise<unknown> {
    const sep = url.includes("?") ? "&" : "?";
    const full = `${url}${sep}mailto=${encodeURIComponent(mailto)}`;
    const res = await fetchImpl(full, {
      headers: { Accept: "application/json", "User-Agent": `OpenLeaf/1.0 (mailto:${mailto})` },
    });
    if (res.status === 404) return null;
    if (res.status === 429) {
      // Polite backoff: caller may retry; treat as soft miss for this attempt.
      return null;
    }
    if (!res.ok) throw Object.assign(new Error(`OpenAlex HTTP ${res.status}`), { status: 502 });
    return res.json();
  }

  return {
    async lookupDoi(doi: string): Promise<ResolvedPaper | null> {
      const normalized = doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
      if (!normalized) return null;
      const cached = await readLookupCache<ResolvedPaper>("doi", `openalex-${normalized}`);
      if (cached) return cached;
      const body = (await getJson(
        `${OPENALEX_BASE}/works/https://doi.org/${encodeURIComponent(normalized)}`,
      )) as Record<string, unknown> | null;
      if (!body) return null;
      const paper = fromOpenAlexWork(body);
      if (paper) await writeLookupCache("doi", `openalex-${normalized}`, paper);
      return paper;
    },

    async searchByTitle(title: string, _authorsHint?: string): Promise<ResolvedPaper | null> {
      const q = title.trim();
      if (!q) return null;
      const cacheKey = q;
      const cached = await readLookupCache<ResolvedPaper>("title", cacheKey);
      if (cached) return cached;
      const filter = `display_name.search:${q}`;
      const body = (await getJson(
        `${OPENALEX_BASE}/works?filter=${encodeURIComponent(filter)}&per-page=5`,
      )) as { results?: Record<string, unknown>[] } | null;
      const results = body?.results ?? [];
      if (results.length === 0) return null;
      const lower = q.toLowerCase();
      const best =
        results.find((r) => String(r.title ?? "").toLowerCase() === lower) ??
        results.find((r) => String(r.title ?? "").toLowerCase().includes(lower.slice(0, 40))) ??
        results[0]!;
      const paper = fromOpenAlexWork(best);
      if (paper) await writeLookupCache("title", cacheKey, paper);
      return paper;
    },
  };
}
