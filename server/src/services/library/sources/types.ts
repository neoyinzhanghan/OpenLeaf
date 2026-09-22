/** Pluggable external metadata clients — mockable in tests. */

export type ResolvedAuthor = { given: string; family: string };

export type ResolvedPaper = {
  doi: string | null;
  arxivId: string | null;
  /** Publisher / DOI / arXiv landing page when known. */
  url: string | null;
  title: string;
  authors: ResolvedAuthor[];
  venue: string;
  year: number | null;
  abstract: string;
  source: "doi" | "arxiv" | "pdf-upload" | "bibtex-import" | "manual";
  /** Raw payload from the upstream API (for cache). */
  raw?: unknown;
};

export type CrossrefClient = {
  lookupDoi(doi: string): Promise<ResolvedPaper | null>;
};

export type OpenAlexClient = {
  searchByTitle(title: string, authorsHint?: string): Promise<ResolvedPaper | null>;
  lookupDoi(doi: string): Promise<ResolvedPaper | null>;
};

export type ArxivClient = {
  lookupId(arxivId: string): Promise<ResolvedPaper | null>;
};

export type SourceClients = {
  crossref: CrossrefClient;
  openalex: OpenAlexClient;
  arxiv: ArxivClient;
};
