import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-dedupe-"));
process.env.OPENLEAF_LIBRARY_ROOT = libraryRoot;

const { loadConfig } = await import("../../config.js");
loadConfig(true);

const { addPaper, closeIndexDb, reindexLibrary } = await import("./index.js");
const { findByArxiv, findLikelyDuplicate, titlesSoftMatch } = await import("./dedupe.js");
const { paperToRis, exportLibraryPapers } = await import("./cite.js");
const {
  addAnnotation,
  listAnnotations,
  updateAnnotation,
  deleteAnnotation,
} = await import("./annotations.js");

describe("library dedupe / export / annotations", () => {
  before(async () => {
    await reindexLibrary();
  });

  after(() => {
    closeIndexDb();
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  });

  it("soft-matches titles", () => {
    assert.equal(
      titlesSoftMatch(
        "Attention Is All You Need",
        "Attention is all you need: Transformer architectures",
      ),
      true,
    );
    assert.equal(titlesSoftMatch("Foo", "Bar"), false);
  });

  it("finds duplicates by arXiv and title", async () => {
    const paper = await addPaper({
      title: "A Novel Calibration Method for Label Shift",
      authors: [{ given: "Jane", family: "Doe" }],
      year: 2024,
      arxivId: "2401.12345",
      source: "arxiv",
    });

    const byArxiv = await findByArxiv("arxiv:2401.12345v2");
    assert.ok(byArxiv);
    assert.equal(byArxiv!.citekey, paper.citekey);

    const byTitle = await findLikelyDuplicate({
      title: "A Novel Calibration Method for Label Shift (extended)",
      authors: [{ given: "J.", family: "Doe" }],
    });
    assert.ok(byTitle);
    assert.equal(byTitle!.match, "title");
    assert.equal(byTitle!.paper.citekey, paper.citekey);
  });

  it("exports BibTeX and RIS", async () => {
    const all = await exportLibraryPapers({
      citekeys: undefined,
      collection: undefined,
      format: "bibtex",
    }).catch((e: Error & { status?: number }) => e);
    // no citekeys/collection → 400
    assert.ok(all instanceof Error);

    const papers = await (await import("./index.js")).listAllRecords();
    assert.ok(papers.length >= 1);
    const bib = await exportLibraryPapers({
      citekeys: [papers[0]!.citekey],
      format: "bibtex",
    });
    assert.match(bib.text, /@/);
    assert.equal(bib.count, 1);

    const ris = await exportLibraryPapers({
      citekeys: [papers[0]!.citekey],
      format: "ris",
    });
    assert.match(ris.text, /^TY {2}- /m);
    assert.match(ris.text, /ER {2}- /);
    assert.match(paperToRis(papers[0]!), /TI {2}- /);
  });

  it("stores PDF annotations beside the record", async () => {
    const papers = await (await import("./index.js")).listAllRecords();
    const citekey = papers[0]!.citekey;
    const ann = await addAnnotation(citekey, {
      kind: "highlight",
      body: "Interesting claim",
      quote: "label shift",
      page: 2,
      x: 120,
      y: 340,
    });
    assert.ok(ann.id.startsWith("ann_"));
    const listed = await listAnnotations(citekey);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.body, "Interesting claim");
    assert.ok(fs.existsSync(path.join(libraryRoot, "papers", citekey, "annotations.json")));
    await deleteAnnotation(citekey, ann.id);
    assert.equal((await listAnnotations(citekey)).length, 0);
  });

  it("supports highlight/underline/area/pin/note with colors and rects", async () => {
    const papers = await (await import("./index.js")).listAllRecords();
    const citekey = papers[0]!.citekey;

    const hl = await addAnnotation(citekey, {
      kind: "highlight",
      quote: "drawn span",
      color: "#4ade80",
      page: 1,
      rects: [
        { x: 40, y: 80, w: 120, h: 14 },
        { x: 40, y: 96, w: 90, h: 14 },
      ],
    });
    assert.equal(hl.kind, "highlight");
    assert.equal(hl.color, "#4ade80");
    assert.equal(hl.rects?.length, 2);
    assert.equal(hl.x, 40);
    assert.equal(hl.y, 80);
    assert.ok((hl.w ?? 0) >= 120);

    const ul = await addAnnotation(citekey, {
      kind: "underline",
      page: 1,
      x: 10,
      y: 200,
      w: 80,
      h: 12,
      color: "#60a5fa",
    });
    assert.equal(ul.kind, "underline");

    const area = await addAnnotation(citekey, {
      kind: "area",
      body: "figure region",
      page: 3,
      x: 50,
      y: 100,
      w: 200,
      h: 150,
    });
    assert.equal(area.kind, "area");

    const pin = await addAnnotation(citekey, {
      kind: "pin",
      body: "check this",
      page: 2,
      x: 90,
      y: 110,
    });
    assert.equal(pin.kind, "pin");

    const note = await addAnnotation(citekey, {
      kind: "note",
      body: "overall takeaway",
      page: 1,
      color: "#a78bfa",
    });
    assert.equal(note.kind, "note");

    const patched = await updateAnnotation(citekey, hl.id, {
      body: "updated body",
      color: "#fb923c",
    });
    assert.equal(patched.body, "updated body");
    assert.equal(patched.color, "#fb923c");
    assert.equal(patched.quote, "drawn span");

    const listed = await listAnnotations(citekey);
    assert.equal(listed.length, 5);

    await assert.rejects(
      () => addAnnotation(citekey, { kind: "pin", page: 1, x: 1, y: 1, body: "" }),
      /Pin notes need a body/,
    );
    await assert.rejects(
      () => addAnnotation(citekey, { kind: "highlight", page: 1 }),
      /Highlights need geometry/,
    );

    for (const a of listed) await deleteAnnotation(citekey, a.id);
    assert.equal((await listAnnotations(citekey)).length, 0);
  });
});
