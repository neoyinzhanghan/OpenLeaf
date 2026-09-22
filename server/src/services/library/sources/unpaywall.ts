import type { ResolvedPaper } from "./types.js";
import { readLookupCache, writeLookupCache } from "./lookupCache.js";

/**
 * Unpaywall — DOI → legal open-access PDF link.
 * Requires an email (polite pool); we reuse the OpenAlex mailto.
 */
export type UnpaywallResult = {
  doi: string;
  isOa: boolean;
  oaUrl: string | null;
  version: string | null;
};

export type UnpaywallClient = {
  lookupDoi(doi: string): Promise<UnpaywallResult | null>;
};

export function createUnpaywallClient(opts?: {
  fetchImpl?: typeof fetch;
  email?: string;
}): UnpaywallClient {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const email = opts?.email ?? "openleaf@localhost";

  return {
    async lookupDoi(doi: string): Promise<UnpaywallResult | null> {
      const normalized = doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
      if (!normalized) return null;
      const cached = await readLookupCache<UnpaywallResult>("doi", `unpaywall-${normalized}`);
      if (cached) return cached;
      const url = `https://api.unpaywall.org/v2/${encodeURIComponent(normalized)}?email=${encodeURIComponent(email)}`;
      const res = await fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": `OpenLeaf/1.0 (mailto:${email})` },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw Object.assign(new Error(`Unpaywall HTTP ${res.status}`), { status: 502 });
      const body = (await res.json()) as {
        doi?: string;
        is_oa?: boolean;
        best_oa_location?: { url_for_pdf?: string | null; version?: string | null } | null;
      };
      const result: UnpaywallResult = {
        doi: body.doi ?? normalized,
        isOa: Boolean(body.is_oa),
        oaUrl: body.best_oa_location?.url_for_pdf ?? null,
        version: body.best_oa_location?.version ?? null,
      };
      await writeLookupCache("doi", `unpaywall-${normalized}`, result);
      return result;
    },
  };
}

/** Semantic Scholar Graph API — abstracts / TLDRs (no key for low volume). */
export type SemanticScholarClient = {
  lookupDoi(doi: string): Promise<Partial<ResolvedPaper> & { tldr?: string } | null>;
};

export function createSemanticScholarClient(opts?: {
  fetchImpl?: typeof fetch;
}): SemanticScholarClient {
  const fetchImpl = opts?.fetchImpl ?? fetch;

  return {
    async lookupDoi(doi: string) {
      const normalized = doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
      if (!normalized) return null;
      const cached = await readLookupCache<Partial<ResolvedPaper> & { tldr?: string }>(
        "doi",
        `s2-${normalized}`,
      );
      if (cached) return cached;
      const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(normalized)}?fields=title,abstract,tldr,year,venue,authors`;
      const res = await fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": "OpenLeaf/1.0" },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw Object.assign(new Error(`Semantic Scholar HTTP ${res.status}`), { status: 502 });
      const body = (await res.json()) as {
        title?: string;
        abstract?: string;
        year?: number;
        venue?: string;
        tldr?: { text?: string };
        authors?: Array<{ name?: string }>;
      };
      const authors = (body.authors ?? []).map((a) => {
        const parts = (a.name ?? "Unknown").trim().split(/\s+/);
        if (parts.length === 1) return { given: "", family: parts[0]! };
        return { given: parts.slice(0, -1).join(" "), family: parts[parts.length - 1]! };
      });
      const result = {
        doi: normalized,
        arxivId: null,
        title: body.title ?? "",
        authors,
        venue: body.venue ?? "",
        year: body.year ?? null,
        abstract: body.abstract ?? "",
        tldr: body.tldr?.text,
        source: "doi" as const,
      };
      await writeLookupCache("doi", `s2-${normalized}`, result);
      return result;
    },
  };
}
