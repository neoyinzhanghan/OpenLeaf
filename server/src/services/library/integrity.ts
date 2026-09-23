/**
 * Existence + retraction checks via Crossref (update-to) and OpenAlex.
 * Writes into record.json integrity block. Cache-by-DOI via lookup cache.
 */
import { getPaper, listAllRecords } from "./index.js";
import { getSourceClients } from "./sources/index.js";
import { createUnpaywallClient } from "./sources/unpaywall.js";
import { readLookupCache, writeLookupCache } from "./sources/lookupCache.js";
import type { PaperIntegrity, PaperRecord } from "./types.js";
import { recordPath } from "./paths.js";
import fs from "node:fs/promises";

/** A paper with any absolute http(s) landing/search URL is considered verified. */
export function hasVerifyingUrl(url: string | null | undefined): boolean {
  return Boolean(url && /^https?:\/\/\S+/i.test(url.trim()));
}

export type IntegrityCheckResult = {
  citekey: string;
  integrity: PaperIntegrity;
  changed: boolean;
  detail?: string;
};

type RetractionCache = {
  existence: PaperIntegrity["existence"];
  retraction: PaperIntegrity["retraction"];
  detail?: string;
  checkedAt: string;
};

async function checkCrossrefRetraction(
  doi: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RetractionCache> {
  const cached = await readLookupCache<RetractionCache>("doi", `retraction-${doi}`, 7 * 24 * 60 * 60 * 1000);
  if (cached) return cached;

  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  const res = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "OpenLeaf/1.0 (mailto:openleaf@localhost)" },
  });
  if (res.status === 404) {
    const result: RetractionCache = {
      existence: "unresolved",
      retraction: "clean",
      detail: "DOI not found in Crossref",
      checkedAt: new Date().toISOString(),
    };
    await writeLookupCache("doi", `retraction-${doi}`, result);
    return result;
  }
  if (!res.ok) {
    throw Object.assign(new Error(`Crossref HTTP ${res.status}`), { status: 502 });
  }
  const body = (await res.json()) as {
    message?: {
      title?: string[];
      "update-to"?: Array<{ type?: string; DOI?: string }>;
      update?: Array<{ type?: string }>;
    };
  };
  const msg = body.message;
  if (!msg) {
    return {
      existence: "unresolved",
      retraction: "clean",
      detail: "Empty Crossref response",
      checkedAt: new Date().toISOString(),
    };
  }

  const updates = [
    ...((msg["update-to"] as Array<{ type?: string }> | undefined) ?? []),
    ...((msg.update as Array<{ type?: string }> | undefined) ?? []),
  ];
  let retraction: PaperIntegrity["retraction"] = "clean";
  for (const u of updates) {
    const t = (u.type ?? "").toLowerCase();
    if (t.includes("retract")) {
      retraction = "retracted";
      break;
    }
    if (t.includes("corrigend") || t.includes("correct") || t.includes("errat")) {
      retraction = "corrected";
    }
  }

  const result: RetractionCache = {
    existence: "verified",
    retraction,
    detail: updates.length ? `update-to: ${updates.map((u) => u.type).join(", ")}` : undefined,
    checkedAt: new Date().toISOString(),
  };
  await writeLookupCache("doi", `retraction-${doi}`, result);
  return result;
}

async function checkTitleMatch(
  paper: PaperRecord,
): Promise<"verified" | "mismatch" | "unresolved"> {
  if (!paper.doi && !paper.title) return "unresolved";
  const clients = getSourceClients();
  try {
    if (paper.doi) {
      const remote =
        (await clients.crossref.lookupDoi(paper.doi)) ?? (await clients.openalex.lookupDoi(paper.doi));
      if (!remote) return "unresolved";
      const local = paper.title.trim().toLowerCase();
      const remoteTitle = remote.title.trim().toLowerCase();
      if (!local || !remoteTitle) return "verified";
      // Soft match: exact or containment of first 40 chars.
      if (local === remoteTitle) return "verified";
      if (local.includes(remoteTitle.slice(0, 40)) || remoteTitle.includes(local.slice(0, 40))) {
        return "verified";
      }
      return "mismatch";
    }
    const remote = await clients.openalex.searchByTitle(paper.title);
    if (!remote) return "unresolved";
    return "verified";
  } catch (err) {
    console.warn(
      `[integrity] title match failed for ${paper.citekey}:`,
      err instanceof Error ? err.message : err,
    );
    return "unresolved";
  }
}

export async function checkPaperIntegrity(
  citekey: string,
  opts?: { force?: boolean; fetchImpl?: typeof fetch },
): Promise<IntegrityCheckResult> {
  const paper = await getPaper(citekey);
  const prev = paper.integrity;

  // Skip if checked within 7 days unless forced.
  if (
    !opts?.force &&
    prev.lastChecked &&
    Date.now() - Date.parse(prev.lastChecked) < 7 * 24 * 60 * 60 * 1000
  ) {
    return { citekey, integrity: prev, changed: false, detail: "skipped-fresh" };
  }

  let existence: PaperIntegrity["existence"] = "unresolved";
  let retraction: PaperIntegrity["retraction"] = "clean";
  let detail: string | undefined;

  if (paper.doi) {
    const arxivFromDoi = paper.doi.match(/^10\.48550\/arxiv\.(.+)$/i)?.[1];
    if (arxivFromDoi || paper.arxivId) {
      const clients = getSourceClients();
      const id = paper.arxivId || arxivFromDoi!;
      const remote = await clients.arxiv.lookupId(id);
      if (remote) {
        existence = "verified";
        detail = "arXiv id resolved (via DOI or arxivId)";
      } else {
        const cr = await checkCrossrefRetraction(paper.doi, opts?.fetchImpl);
        existence = cr.existence;
        retraction = cr.retraction;
        detail = cr.detail ?? "arXiv lookup failed; used Crossref";
      }
    } else {
      const cr = await checkCrossrefRetraction(paper.doi, opts?.fetchImpl);
      existence = cr.existence;
      retraction = cr.retraction;
      detail = cr.detail;
      if (existence === "verified") {
        const match = await checkTitleMatch(paper);
        if (match === "mismatch") existence = "mismatch";
      } else if (existence === "unresolved") {
        // Crossref miss — try OpenAlex before giving up.
        const match = await checkTitleMatch(paper);
        if (match === "verified") {
          existence = "verified";
          detail = "Crossref miss; verified via OpenAlex/title";
        }
      }
    }
  } else if (paper.arxivId) {
    const clients = getSourceClients();
    const remote = await clients.arxiv.lookupId(paper.arxivId);
    existence = remote ? "verified" : "unresolved";
    detail = remote ? "arXiv id resolved" : "arXiv id not found";
  } else if (paper.title) {
    existence = await checkTitleMatch(paper);
    detail = "title search via OpenAlex";
  }

  // Policy: any absolute public URL is enough to mark the paper verified
  // (DOI/arXiv preferred above; books, news, and org pages verify via their link).
  if (existence !== "verified" && existence !== "mismatch" && hasVerifyingUrl(paper.url)) {
    existence = "verified";
    detail = detail ? `${detail}; public URL present` : "public URL present";
  }

  const integrity: PaperIntegrity = {
    existence,
    retraction,
    lastChecked: new Date().toISOString(),
    reason:
      existence === "verified"
        ? null
        : detail?.trim() ||
          (existence === "mismatch"
            ? "Title does not match Crossref/OpenAlex metadata for this DOI"
            : hasVerifyingUrl(paper.url)
              ? "Could not verify identifiers"
              : "No public URL — add at least one link (DOI, arXiv, publisher, or source page)"),
  };

  const changed =
    integrity.existence !== prev.existence ||
    integrity.retraction !== prev.retraction ||
    integrity.lastChecked !== prev.lastChecked ||
    (integrity.reason ?? null) !== (prev.reason ?? null);

  // Persist integrity into record.json (source of truth).
  await writeIntegrity(citekey, integrity);

  return { citekey, integrity, changed, detail };
}

async function writeIntegrity(citekey: string, integrity: PaperIntegrity): Promise<PaperRecord> {
  const paper = await getPaper(citekey);
  const next = { ...paper, integrity };
  await fs.writeFile(recordPath(citekey), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/** Mark a paper as unresolved with an explicit human-readable reason (books, news, etc.). */
export async function setUnresolvedReason(citekey: string, reason: string): Promise<PaperRecord> {
  const paper = await getPaper(citekey);
  const trimmed = reason.trim();
  if (!trimmed) throw Object.assign(new Error("Integrity reason is required"), { status: 400 });
  return writeIntegrity(citekey, {
    existence: "unresolved",
    retraction: paper.integrity.retraction ?? "clean",
    lastChecked: new Date().toISOString(),
    reason: trimmed,
  });
}

export async function checkLibraryIntegrity(opts?: {
  force?: boolean;
  citekeys?: string[];
}): Promise<IntegrityCheckResult[]> {
  const papers = opts?.citekeys
    ? await Promise.all(opts.citekeys.map((c) => getPaper(c)))
    : await listAllRecords();
  const results: IntegrityCheckResult[] = [];
  for (const paper of papers) {
    results.push(await checkPaperIntegrity(paper.citekey, { force: opts?.force }));
  }
  return results;
}

/** Optional OA PDF fetch helper for later claim-check / fulltext milestones. */
export async function resolveOpenAccessPdf(doi: string): Promise<string | null> {
  const client = createUnpaywallClient();
  const result = await client.lookupDoi(doi);
  return result?.oaUrl ?? null;
}
