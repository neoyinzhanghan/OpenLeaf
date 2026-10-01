/**
 * Verify-first gate for AI-proposed library citations.
 *
 * Stricter than host integrity: Scholar, GitHub, and bare publisher HTML do not count.
 * A DOI, an arXiv id, or an OpenReview forum/pdf note must resolve
 * (or title + OpenAlex soft-match that itself has a DOI or arXiv id).
 */
import { findLikelyDuplicate, titlesSoftMatch } from "./dedupe.js";
import { lookupExternal, detectLink } from "./import.js";
import { addPaper, deletePaper } from "./index.js";
import { checkPaperIntegrity, checkCrossrefRetraction } from "./integrity.js";
import { normalizeArxivId } from "./sources/arxiv.js";
import { lookupOpenReviewNote, openReviewNoteIdFromUrl } from "./sources/openreview.js";
import { type ResolvedPaper } from "./sources/index.js";
import { normalizeDoi } from "./paperUrl.js";
import type { CreatePaperInput, PaperAuthor, PaperRecord } from "./types.js";

export type ProposalInput = {
  doi?: string | null;
  arxivId?: string | null;
  url?: string | null;
  title?: string | null;
  authors?: PaperAuthor[] | null;
  year?: number | null;
  venue?: string | null;
  abstract?: string | null;
  tags?: string[] | null;
  notes?: string | null;
  citekey?: string | null;
};

export type RejectCode =
  | "INVALID_INPUT"
  | "MISSING_TITLE"
  | "NO_PUBLIC_IDENTIFIER"
  | "DOI_NOT_FOUND"
  | "ARXIV_NOT_FOUND"
  | "UNRESOLVABLE_URL"
  | "TITLE_MISMATCH"
  | "HALLUCINATED"
  | "RETRACTED"
  | "DUPLICATE"
  | "INTEGRITY_FAILED";

export type VerifyAccept = {
  ok: true;
  decision: "accept";
  resolved: ResolvedPaper;
  checks: {
    identifier: "doi" | "arxiv" | "openreview" | "title";
    titleMatch: boolean;
    retraction: "clean" | "retracted" | "corrected";
  };
};

export type VerifyReject = {
  ok: false;
  decision: "reject";
  code: RejectCode;
  reason: string;
  hint: string;
  expected?: Partial<ResolvedPaper>;
  existingCitekey?: string;
  retry?: {
    preferred: "doi-only" | "arxiv-only" | "corrected-title" | "provide-identifier";
    example?: Record<string, string>;
  };
};

export type VerifyResult = VerifyAccept | VerifyReject;

export type AddResult =
  | {
      ok: true;
      decision: "accept";
      created: boolean;
      paper: PaperRecord;
      match?: string;
      verify: VerifyAccept;
    }
  | (VerifyReject & { created?: false });

function reject(
  code: RejectCode,
  reason: string,
  hint: string,
  extra?: Partial<VerifyReject>,
): VerifyReject {
  return { ok: false, decision: "reject", code, reason, hint, ...extra };
}

function asAuthors(authors: PaperAuthor[] | null | undefined): PaperAuthor[] {
  return Array.isArray(authors) ? authors.filter((a) => a?.family?.trim()) : [];
}

/** Title + first-author duplicate, including a published DOI of an existing preprint. */
async function duplicateReject(resolved: ResolvedPaper): Promise<VerifyReject | null> {
  const dup = await findLikelyDuplicate({
    doi: resolved.doi,
    arxivId: resolved.arxivId,
    title: resolved.title,
    authors: resolved.authors,
  });
  if (!dup) return null;
  return reject(
    "DUPLICATE",
    `Already in library as ${dup.paper.citekey} (matched by ${dup.match}).`,
    `Use library_get("${dup.paper.citekey}") instead of adding again.`,
    {
      existingCitekey: dup.paper.citekey,
      expected: {
        title: dup.paper.title,
        doi: dup.paper.doi,
        arxivId: dup.paper.arxivId,
        year: dup.paper.year,
        venue: dup.paper.venue,
        authors: dup.paper.authors,
        url: dup.paper.url,
        abstract: dup.paper.abstract,
        source: dup.paper.source,
      },
    },
  );
}

/** Pull DOI / arXiv out of a pasted URL when the AI only sent `url`. */
function hydrateFromUrl(input: ProposalInput): ProposalInput {
  const url = input.url?.trim();
  if (!url) return input;
  const detected = detectLink(url);
  const next = { ...input };
  if (detected.kind === "doi" && !next.doi) next.doi = detected.value;
  if (detected.kind === "arxiv" && !next.arxivId) next.arxivId = detected.value;
  return next;
}

/**
 * Real Crossref update-to check (same one integrity.ts runs post-add) — this
 * used to be a stub that always returned "clean" without ever calling
 * Crossref, which meant "retraction: clean" was returned to callers of
 * /verify as if it had been checked when it hadn't. A genuine network/HTTP
 * failure here throws (fail-closed) rather than being swallowed into
 * "clean", so a Crossref outage rejects the verify instead of silently
 * letting a possibly-retracted paper through.
 */
async function checkRetraction(
  doi: string,
  fetchImpl?: typeof fetch,
): Promise<"clean" | "retracted" | "corrected"> {
  const result = await checkCrossrefRetraction(doi, fetchImpl);
  return result.retraction;
}

/**
 * Verify a proposed citation without writing.
 * Prefer DOI → arXiv → OpenReview note → title+OpenAlex.
 * Scholar pages, GitHub repos, and unresolved publisher HTML stay rejected.
 */
export async function verifyProposal(
  raw: ProposalInput,
  opts?: { fetchImpl?: typeof fetch },
): Promise<VerifyResult> {
  const input = hydrateFromUrl(raw);
  const doi = input.doi?.trim() ? normalizeDoi(input.doi) : "";
  const arxivId = input.arxivId?.trim() ? normalizeArxivId(input.arxivId) : "";
  const title = input.title?.trim() ?? "";
  const authors = asAuthors(input.authors);
  const url = input.url?.trim() ?? "";

  if (!doi && !arxivId && !title && !url) {
    return reject(
      "INVALID_INPUT",
      "Proposal is empty — need a DOI, arXiv id, resolvable URL, or title.",
      "Call library_verify / library_add with at least { doi } or { arxivId } (preferred) or { title } plus authors.",
      { retry: { preferred: "provide-identifier" } },
    );
  }

  // Duplicate check early (even before external resolve) when identifiers present.
  const earlyDup = await findLikelyDuplicate({
    doi: doi || null,
    arxivId: arxivId || null,
    title: title || null,
    authors,
  });
  if (earlyDup && (earlyDup.match === "doi" || earlyDup.match === "arxiv")) {
    return reject(
      "DUPLICATE",
      `Already in library as ${earlyDup.paper.citekey} (matched by ${earlyDup.match}).`,
      `Do not re-add. Use library_get with citekey "${earlyDup.paper.citekey}" if you need the record.`,
      {
        existingCitekey: earlyDup.paper.citekey,
        expected: {
          title: earlyDup.paper.title,
          doi: earlyDup.paper.doi,
          arxivId: earlyDup.paper.arxivId,
          year: earlyDup.paper.year,
          venue: earlyDup.paper.venue,
          authors: earlyDup.paper.authors,
          url: earlyDup.paper.url,
          abstract: earlyDup.paper.abstract,
          source: earlyDup.paper.source,
        },
      },
    );
  }

  if (doi) {
    const resolved = await lookupExternal({ doi });
    if (!resolved) {
      return reject(
        "DOI_NOT_FOUND",
        `DOI ${doi} was not found in Crossref/OpenAlex.`,
        "Double-check the DOI, or switch to a real arXiv abs URL. Never invent a DOI.",
        {
          retry: {
            preferred: "doi-only",
            example: { doi: "10.xxxx/...." },
          },
        },
      );
    }
    if (title && !titlesSoftMatch(title, resolved.title)) {
      return reject(
        "TITLE_MISMATCH",
        `Proposed title does not match the record for DOI ${doi}.`,
        "Retry library_add with only the DOI (recommended), or use the expected.title below.",
        {
          expected: resolved,
          retry: {
            preferred: "doi-only",
            example: { doi },
          },
        },
      );
    }
    const dup = await duplicateReject(resolved);
    if (dup) return dup;
    const retraction = await checkRetraction(doi, opts?.fetchImpl);
    if (retraction === "retracted") {
      return reject(
        "RETRACTED",
        `DOI ${doi} appears retracted.`,
        "Do not add retracted papers. Pick a different source.",
        { expected: resolved },
      );
    }
    return {
      ok: true,
      decision: "accept",
      resolved,
      checks: {
        identifier: "doi",
        titleMatch: !title || titlesSoftMatch(title, resolved.title),
        retraction,
      },
    };
  }

  if (arxivId) {
    const resolved = await lookupExternal({ arxivId });
    if (!resolved) {
      return reject(
        "ARXIV_NOT_FOUND",
        `arXiv id ${arxivId} was not found.`,
        "Use a real https://arxiv.org/abs/… URL or drop arxivId and provide a DOI.",
        {
          retry: {
            preferred: "arxiv-only",
            example: { arxivId: "2401.01234" },
          },
        },
      );
    }
    if (title && !titlesSoftMatch(title, resolved.title)) {
      return reject(
        "TITLE_MISMATCH",
        `Proposed title does not match arXiv:${arxivId}.`,
        "Retry with only { arxivId }, or use expected.title.",
        {
          expected: resolved,
          retry: { preferred: "arxiv-only", example: { arxivId } },
        },
      );
    }
    const dup = await duplicateReject(resolved);
    if (dup) return dup;
    return {
      ok: true,
      decision: "accept",
      resolved,
      checks: {
        identifier: "arxiv",
        titleMatch: !title || titlesSoftMatch(title, resolved.title),
        retraction: "clean",
      },
    };
  }

  if (url && /^https?:\/\//i.test(url)) {
    const noteId = openReviewNoteIdFromUrl(url);
    if (noteId) {
      const looked = await lookupOpenReviewNote(noteId, opts?.fetchImpl ?? fetch);
      if (!looked.ok) {
        if (looked.reason === "blocked") {
          return reject(
            "UNRESOLVABLE_URL",
            `OpenReview note ${noteId} could not be read (HTTP ${looked.status}).`,
            "OpenReview did not return this note. Retry later, or supply a DOI or arXiv id. Scholar pages and GitHub repositories are not a substitute for the forum note.",
            {
              retry: {
                preferred: "provide-identifier",
                example: { url: `https://openreview.net/forum?id=${noteId}` },
              },
            },
          );
        }
        return reject(
          "UNRESOLVABLE_URL",
          `OpenReview note ${noteId} was not found.`,
          "Check the forum id, or supply a DOI or arXiv id.",
          { retry: { preferred: "provide-identifier" } },
        );
      }
      const resolved = looked.paper;
      if (title && !titlesSoftMatch(title, resolved.title)) {
        return reject(
          "TITLE_MISMATCH",
          `Proposed title does not match OpenReview note ${noteId}.`,
          "Retry with only the forum URL, or use expected.title.",
          {
            expected: resolved,
            retry: {
              preferred: "provide-identifier",
              example: { url: `https://openreview.net/forum?id=${noteId}` },
            },
          },
        );
      }
      const dup = await duplicateReject(resolved);
      if (dup) return dup;
      let retraction: "clean" | "retracted" | "corrected" = "clean";
      if (resolved.doi) {
        retraction = await checkRetraction(resolved.doi, opts?.fetchImpl);
        if (retraction === "retracted") {
          return reject(
            "RETRACTED",
            `OpenReview note ${noteId} points at retracted DOI ${resolved.doi}.`,
            "Do not add retracted papers. Pick a different source.",
            { expected: resolved },
          );
        }
      }
      return {
        ok: true,
        decision: "accept",
        resolved,
        checks: {
          identifier: "openreview",
          titleMatch: !title || titlesSoftMatch(title, resolved.title),
          retraction,
        },
      };
    }
    return reject(
      "UNRESOLVABLE_URL",
      `URL could not be reduced to a DOI, arXiv id, or OpenReview note: ${url}`,
      "Paste a DOI (10.…), an arXiv abs link, or an OpenReview forum URL (openreview.net/forum?id=…). Scholar pages, GitHub repositories, and publisher HTML alone are not enough.",
      { retry: { preferred: "provide-identifier" } },
    );
  }

  if (!title) {
    return reject(
      "MISSING_TITLE",
      "No DOI/arXiv and no title to look up.",
      "Provide a DOI or arXiv id (preferred), or a title plus first author.",
      { retry: { preferred: "provide-identifier" } },
    );
  }

  const resolved = await lookupExternal({ title });
  if (!resolved) {
    return reject(
      "HALLUCINATED",
      `No Crossref/OpenAlex hit for title “${title}”.`,
      "This citation looks invented. Find a real DOI/arXiv before retrying. Do not fabricate identifiers.",
      { retry: { preferred: "provide-identifier" } },
    );
  }
  if (!titlesSoftMatch(title, resolved.title)) {
    return reject(
      "TITLE_MISMATCH",
      "OpenAlex returned a different paper than the proposed title.",
      "Use expected.doi / expected.title, or supply the correct DOI.",
      {
        expected: resolved,
        retry: {
          preferred: "corrected-title",
          example: resolved.doi
            ? { doi: resolved.doi }
            : { title: resolved.title },
        },
      },
    );
  }

  // Title-only accepts require a resolved public identifier on the remote hit.
  if (!resolved.doi && !resolved.arxivId) {
    return reject(
      "NO_PUBLIC_IDENTIFIER",
      "Title matched a remote record that has no DOI or arXiv id.",
      "Refuse to add; ask for a DOI/arXiv from the human, or skip this paper.",
      { expected: resolved },
    );
  }

  const titleDup = await duplicateReject(resolved);
  if (titleDup) return titleDup;

  return {
    ok: true,
    decision: "accept",
    resolved,
    checks: {
      identifier: "title",
      titleMatch: true,
      retraction: "clean",
    },
  };
}

function resolvedToCreateInput(resolved: ResolvedPaper, input: ProposalInput): CreatePaperInput {
  return {
    citekey: input.citekey?.trim() || undefined,
    doi: resolved.doi,
    arxivId: resolved.arxivId,
    url: resolved.url,
    title: resolved.title,
    authors: resolved.authors.length ? resolved.authors : asAuthors(input.authors),
    venue: resolved.venue || input.venue || "",
    year: resolved.year ?? input.year ?? null,
    abstract: resolved.abstract || input.abstract || "",
    tags: input.tags ?? [],
    notes: input.notes ?? "",
    source: resolved.source === "arxiv" ? "arxiv" : resolved.doi ? "doi" : "manual",
  };
}

/**
 * Verify a proposal for the library AI review queue (no write).
 * Host Accept later calls addVerifiedPaper.
 */
export async function proposeVerifiedPaper(
  raw: ProposalInput,
  opts?: { fetchImpl?: typeof fetch },
): Promise<
  | { ok: true; decision: "pending"; verify: VerifyAccept; proposal: ProposalInput }
  | VerifyReject
> {
  const verify = await verifyProposal(raw, opts);
  if (!verify.ok) return verify;
  return {
    ok: true,
    decision: "pending",
    verify,
    proposal: hydrateFromUrl(raw),
  };
}

/**
 * Verify then add. On post-add integrity failure (mismatch/retracted), delete and reject.
 * Duplicates return reject (do not silently re-add).
 */
export async function addVerifiedPaper(
  raw: ProposalInput,
  opts?: { fetchImpl?: typeof fetch },
): Promise<AddResult> {
  const verify = await verifyProposal(raw, opts);
  if (!verify.ok) return verify;

  // Re-check duplicate against resolved identifiers (title path may have upgraded DOI).
  const dup = await findLikelyDuplicate({
    doi: verify.resolved.doi,
    arxivId: verify.resolved.arxivId,
    title: verify.resolved.title,
    authors: verify.resolved.authors,
  });
  if (dup) {
    return reject(
      "DUPLICATE",
      `Already in library as ${dup.paper.citekey} (matched by ${dup.match}).`,
      `Use library_get("${dup.paper.citekey}") instead of adding again.`,
      { existingCitekey: dup.paper.citekey },
    );
  }

  const paper = await addPaper(resolvedToCreateInput(verify.resolved, hydrateFromUrl(raw)));
  try {
    const integrity = await checkPaperIntegrity(paper.citekey, { force: true, fetchImpl: opts?.fetchImpl });
    if (integrity.integrity.retraction === "retracted") {
      await deletePaper(paper.citekey);
      return reject(
        "RETRACTED",
        `Paper ${paper.citekey} is retracted — not added.`,
        "Do not cite retracted work. Choose another source.",
        { expected: verify.resolved },
      );
    }
    if (integrity.integrity.existence === "mismatch") {
      await deletePaper(paper.citekey);
      return reject(
        "INTEGRITY_FAILED",
        `Saved metadata mismatched remote sources for ${paper.citekey} — rolled back.`,
        "Retry with DOI-only using the Crossref title, or skip this paper.",
        {
          expected: verify.resolved,
          retry: {
            preferred: "doi-only",
            example: verify.resolved.doi ? { doi: verify.resolved.doi } : undefined,
          },
        },
      );
    }
    // Reload after integrity write.
    const { getPaper } = await import("./index.js");
    const updated = await getPaper(paper.citekey);
    return { ok: true, decision: "accept", created: true, paper: updated, verify };
  } catch (err) {
    // Keep the paper if integrity check itself failed (network) — verify already passed.
    console.warn(
      `[library-ai] post-add integrity check failed for ${paper.citekey}:`,
      err instanceof Error ? err.message : err,
    );
    return { ok: true, decision: "accept", created: true, paper, verify };
  }
}
