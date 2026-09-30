import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ReadableStream } from "node:stream/web";

// pdfFetch.ts had no test coverage before this audit. It downloads a PDF from
// a third-party OA host (Unpaywall/arXiv) with no timeout or size cap, which
// could exhaust server memory/disk given a slow or oversized response. Cover
// the fix: the response body must be capped while streaming, not only after
// the whole thing has already been buffered.

const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-pdffetch-lib-"));
process.env.OPENLEAF_LIBRARY_ROOT = libraryRoot;
process.env.OPENLEAF_PROJECTS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-pdffetch-proj-"));

const { loadConfig } = await import("../../config.js");
loadConfig(true);

const { addPaper, closeIndexDb, reindexLibrary } = await import("./index.js");
const { fetchAndAttachPdf } = await import("./pdfFetch.js");

function streamingResponse(totalBytes: number, chunkSize = 1024 * 64): Response {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const n = Math.min(chunkSize, totalBytes - sent);
      controller.enqueue(new Uint8Array(n).fill(65));
      sent += n;
    },
  });
  return new Response(body as unknown as BodyInit, {
    status: 200,
    headers: { "content-type": "application/octet-stream" },
  });
}

describe("fetchAndAttachPdf — resource limits", () => {
  before(async () => {
    await reindexLibrary();
  });

  after(() => {
    closeIndexDb();
  });

  it("aborts a stream that exceeds the byte cap instead of buffering it all", async () => {
    // arXiv paper: resolveDirectPdfUrl builds the URL directly with no
    // network round-trip, so the only fetch made is the injected one below
    // (a DOI-only paper would hit the real Unpaywall client instead).
    const paper = await addPaper({
      title: "Open Access Paper With A Huge PDF",
      arxivId: "2401.00001",
    });

    const oversized = 5 * 1024 * 1024; // 5 MB body
    const cap = 1024 * 1024; // 1 MB cap for the test

    const fetchImpl = (async () => streamingResponse(oversized)) as unknown as typeof fetch;

    await assert.rejects(
      () => fetchAndAttachPdf(paper.citekey, { fetchImpl, maxBytes: cap }),
      (e: unknown) => {
        assert.match((e as Error).message, /exceeded/i);
        return true;
      },
    );
  });

  it("rejects immediately on a Content-Length that already exceeds the cap", async () => {
    const paper = await addPaper({
      title: "Open Access Paper With Declared Huge Length",
      arxivId: "2401.00002",
    });

    const cap = 1024;
    const fetchImpl = (async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(10));
          controller.close();
        },
      });
      return new Response(body as unknown as BodyInit, {
        status: 200,
        headers: { "content-length": String(cap * 100) },
      });
    }) as unknown as typeof fetch;

    // The declared Content-Length alone (100x the cap) is enough to reject,
    // regardless of how much of the body the runtime happens to buffer while
    // constructing/inspecting the Response.
    await assert.rejects(
      () => fetchAndAttachPdf(paper.citekey, { fetchImpl, maxBytes: cap }),
      (e: unknown) => {
        assert.match((e as Error).message, /exceeded/i);
        return true;
      },
    );
  });
});
