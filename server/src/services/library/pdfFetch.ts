/**
 * Resolve and download a direct PDF for a library paper (arXiv / Unpaywall OA).
 */
import fs from "node:fs";
import { getPaper } from "./index.js";
import { savePaperAttachment } from "./import.js";
import { resolveOpenAccessPdf } from "./integrity.js";
import { attachmentPath } from "./paths.js";
import { normalizeArxivId } from "./sources/arxiv.js";
import type { PaperRecord } from "./types.js";

export type PdfSourceHint = {
  citekey: string;
  hasLocal: boolean;
  /** Ready-to-fetch URL when known without a network round-trip. */
  directUrl: string | null;
  source: "local" | "arxiv" | "unpaywall" | "none";
  /** True when a fetch is likely to succeed (arxiv always; unpaywall needs lookup). */
  canFetch: boolean;
};

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function arxivPdfUrl(arxivId: string): string {
  const id = normalizeArxivId(arxivId).replace(/v\d+$/i, "");
  return `https://arxiv.org/pdf/${id}.pdf`;
}

function arxivIdFromPaper(paper: PaperRecord): string | null {
  if (paper.arxivId?.trim()) return normalizeArxivId(paper.arxivId);
  const fromDoi = paper.doi?.match(/^10\.48550\/arxiv\.(.+)$/i)?.[1];
  return fromDoi ? normalizeArxivId(fromDoi) : null;
}

function hasLocalPdf(paper: PaperRecord): boolean {
  if (!paper.attachment) return false;
  return fs.existsSync(attachmentPath(paper.citekey));
}

/** Cheap hint (no Unpaywall call). Use for list icons / detail buttons. */
export function pdfSourceHintSync(paper: PaperRecord): PdfSourceHint {
  if (hasLocalPdf(paper)) {
    return {
      citekey: paper.citekey,
      hasLocal: true,
      directUrl: null,
      source: "local",
      canFetch: false,
    };
  }
  const arxivId = arxivIdFromPaper(paper);
  if (arxivId) {
    return {
      citekey: paper.citekey,
      hasLocal: false,
      directUrl: arxivPdfUrl(arxivId),
      source: "arxiv",
      canFetch: true,
    };
  }
  if (paper.doi?.trim()) {
    return {
      citekey: paper.citekey,
      hasLocal: false,
      directUrl: null,
      source: "unpaywall",
      canFetch: true,
    };
  }
  return {
    citekey: paper.citekey,
    hasLocal: false,
    directUrl: null,
    source: "none",
    canFetch: false,
  };
}

/** Resolve the best download URL (may call Unpaywall). */
export async function resolveDirectPdfUrl(paper: PaperRecord): Promise<{
  url: string;
  source: "arxiv" | "unpaywall";
} | null> {
  const arxivId = arxivIdFromPaper(paper);
  if (arxivId) return { url: arxivPdfUrl(arxivId), source: "arxiv" };
  if (paper.doi?.trim()) {
    const oa = await resolveOpenAccessPdf(paper.doi);
    if (oa) return { url: oa, source: "unpaywall" };
  }
  return null;
}

export async function getPdfSourceHint(citekey: string): Promise<PdfSourceHint> {
  const paper = await getPaper(citekey);
  const hint = pdfSourceHintSync(paper);
  if (hint.hasLocal || hint.source === "arxiv" || hint.source === "none") return hint;
  // Probe Unpaywall so the UI can hide a dead Download button.
  const resolved = await resolveDirectPdfUrl(paper);
  if (!resolved) {
    return { ...hint, source: "none", canFetch: false };
  }
  return {
    citekey,
    hasLocal: false,
    directUrl: resolved.url,
    source: resolved.source,
    canFetch: true,
  };
}

/** Hard cap on a downloaded OA PDF. Generous for a real paper, small enough to bound memory/disk. */
const MAX_PDF_BYTES = 100 * 1024 * 1024; // 100 MB
/** The OA host can be any third-party publisher/repository; bound how long we wait on it. */
const PDF_FETCH_TIMEOUT_MS = 45_000;

/**
 * Read a fetch Response body up to `maxBytes`, aborting as soon as the cap is
 * exceeded rather than buffering the whole thing first — a slow or
 * misconfigured OA host must not be able to exhaust server memory/disk by
 * streaming an arbitrarily large (or infinite) body.
 */
async function readBodyWithCap(res: Response, maxBytes: number): Promise<Buffer> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    // Fallback (e.g. a test double without a real stream): buffer, then check.
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw httpError(502, `PDF exceeded the ${maxBytes} byte limit`);
    }
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw httpError(502, `PDF exceeded the ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

export async function fetchAndAttachPdf(
  citekey: string,
  opts?: { fetchImpl?: typeof fetch; maxBytes?: number; timeoutMs?: number },
): Promise<{ paper: PaperRecord; source: "arxiv" | "unpaywall"; bytes: number }> {
  const paper = await getPaper(citekey);
  if (hasLocalPdf(paper)) {
    throw httpError(409, "PDF already attached");
  }
  const resolved = await resolveDirectPdfUrl(paper);
  if (!resolved) {
    throw httpError(404, "No direct PDF download available for this paper");
  }

  const maxBytes = opts?.maxBytes ?? MAX_PDF_BYTES;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const res = await fetchImpl(resolved.url, {
    headers: {
      Accept: "application/pdf,*/*",
      "User-Agent": "OpenLeaf/1.0 (library PDF fetch)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(opts?.timeoutMs ?? PDF_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw httpError(502, `PDF download failed (${res.status}) from ${resolved.source}`);
  }
  const declaredLength = Number(res.headers?.get?.("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw httpError(502, `PDF exceeded the ${maxBytes} byte limit`);
  }
  const buf = await readBodyWithCap(res, maxBytes);
  if (buf.length < 5 || buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw httpError(502, "Downloaded file is not a PDF");
  }
  await savePaperAttachment(citekey, buf);
  const updated = await getPaper(citekey);
  return { paper: updated, source: resolved.source, bytes: buf.length };
}
