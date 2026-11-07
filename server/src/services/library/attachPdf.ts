/**
 * Attach or replace a paper's PDF. Replace clears fact highlights (untag)
 * but preserves fact status / answers.
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { getPaper } from "./index.js";
import { savePaperAttachment } from "./import.js";
import { countTaggedFacts, untagAllFacts } from "./facts.js";
import { attachmentPath, pdfTextCachePath } from "./paths.js";

const MAX_PDF_BYTES = 100 * 1024 * 1024;

function httpError(status: number, message: string, extra?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { status, ...(extra ?? {}) });
}

function isPdfMagic(buf: Buffer): boolean {
  return buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

export type AttachPdfResult = {
  paper: Awaited<ReturnType<typeof getPaper>>;
  replaced: boolean;
  factsUntagged: number;
};

/**
 * Attach a PDF to `citekey`. If one already exists, require `replace: true`
 * (after the client has warned about untagging).
 */
export async function attachOrReplacePaperPdf(
  citekey: string,
  buffer: Buffer,
  opts?: { replace?: boolean },
): Promise<AttachPdfResult> {
  const paper = await getPaper(citekey);
  if (!isPdfMagic(buffer)) {
    throw httpError(400, "File is not a PDF (missing %PDF- header)");
  }
  if (buffer.length > MAX_PDF_BYTES) {
    throw httpError(400, `PDF exceeds ${MAX_PDF_BYTES / (1024 * 1024)} MB limit`);
  }

  const hasPdf =
    Boolean(paper.attachment) && fs.existsSync(attachmentPath(citekey));
  const taggedCount = hasPdf ? await countTaggedFacts(citekey) : 0;

  if (hasPdf && !opts?.replace) {
    const totalFacts = await countTaggedFacts(citekey, { includeUntagged: true });
    throw httpError(409, "Paper already has a PDF. Confirm replace to overwrite.", {
      code: "PDF_EXISTS",
      taggedFactCount: taggedCount,
      totalFacts,
    });
  }

  await savePaperAttachment(citekey, buffer);

  // Force text-layer re-extract on next facts/capability read.
  const cache = pdfTextCachePath(citekey);
  if (fs.existsSync(cache)) {
    await fsPromises.unlink(cache).catch(() => undefined);
  }

  let factsUntagged = 0;
  if (hasPdf) {
    factsUntagged = await untagAllFacts(citekey);
  }

  const next = await getPaper(citekey);
  return { paper: next, replaced: hasPdf, factsUntagged };
}

export async function pdfReplacePreview(citekey: string): Promise<{
  hasPdf: boolean;
  taggedFactCount: number;
  totalFacts: number;
}> {
  const paper = await getPaper(citekey);
  const hasPdf =
    Boolean(paper.attachment) && fs.existsSync(attachmentPath(citekey));
  const taggedFactCount = hasPdf ? await countTaggedFacts(citekey) : 0;
  const totalFacts = await countTaggedFacts(citekey, { includeUntagged: true });
  return { hasPdf, taggedFactCount, totalFacts };
}
