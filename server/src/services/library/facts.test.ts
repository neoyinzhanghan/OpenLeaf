import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-facts-"));
process.env.OPENLEAF_LIBRARY_ROOT = libraryRoot;

const { loadConfig } = await import("../../config.js");
loadConfig(true);

const { addPaper, closeIndexDb, reindexLibrary, updatePaper } = await import("./index.js");
const {
  createFact,
  deleteFact,
  getFactsCapability,
  listAllFacts,
  listFacts,
  untagAllFacts,
  updateFact,
} = await import("./facts.js");
const { locateQuoteInPages, offsetsToRects } = await import("./pdfText.js");
import type { PdfTextPage } from "./pdfText.js";

describe("library facts", () => {
  let citekey = "";

  before(async () => {
    await reindexLibrary();
    const paper = await addPaper({
      title: "Demo Paper on TCGA-NSCLC",
      source: "manual",
      authors: [{ family: "Doe", given: "Jane" }],
    });
    citekey = paper.citekey;
    const dir = path.join(libraryRoot, "papers", citekey);
    fs.mkdirSync(dir, { recursive: true });
    const pdfPath = path.join(dir, "attachment.pdf");
    fs.writeFileSync(pdfPath, "%PDF-1.4 fake\n");
    const st = fs.statSync(pdfPath);
    const pages: PdfTextPage[] = [
      {
        page: 1,
        width: 612,
        height: 792,
        text: "Abstract. The proposed model outperforms TransMIL on TCGA-NSCLC with AUROC 0.91.",
        items: [
          {
            str: "Abstract. The proposed model outperforms TransMIL on TCGA-NSCLC with AUROC 0.91.",
            start: 0,
            end: 79,
            x: 72,
            y: 100,
            w: 400,
            h: 12,
          },
        ],
      },
      {
        page: 2,
        width: 612,
        height: 792,
        text: "Proposition 3.1 (Convergence Theorem). The sequence converges.",
        items: [
          {
            str: "Proposition 3.1 (Convergence Theorem). The sequence converges.",
            start: 0,
            end: 61,
            x: 72,
            y: 120,
            w: 380,
            h: 12,
          },
        ],
      },
    ];
    fs.writeFileSync(
      path.join(dir, "pdf-text.json"),
      JSON.stringify({
        version: 2,
        extractedAt: new Date().toISOString(),
        sourceBytes: st.size,
        sourceMtimeMs: st.mtimeMs,
        pages,
      }),
    );
    await updatePaper(citekey, { attachment: "attachment.pdf" });
  });

  after(() => {
    closeIndexDb();
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  });

  it("locates quotes with whitespace-normalized matching", () => {
    const pages: PdfTextPage[] = [
      {
        page: 1,
        width: 100,
        height: 100,
        text: "Hello   world\nfrom PDF",
        items: [
          { str: "Hello   world", start: 0, end: 13, x: 10, y: 10, w: 50, h: 10 },
          { str: "from PDF", start: 14, end: 22, x: 10, y: 22, w: 40, h: 10 },
        ],
      },
    ];
    const hits = locateQuoteInPages(pages, "hello world from pdf");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.page, 1);
    assert.ok(hits[0]!.end > hits[0]!.start);
    const rects = offsetsToRects(pages[0]!, hits[0]!.start, hits[0]!.end);
    assert.ok(rects.length >= 1);
  });

  it("rejects numeric needles glued inside longer numbers", () => {
    const pages: PdfTextPage[] = [
      {
        page: 1,
        width: 200,
        height: 200,
        text: "CLAM-MB 95.592.16 DSMIL 92.11 AHDMIL 0.9750.004 NATMIL 0.940 ± 0.027",
        items: [
          { str: "95.59", start: 8, end: 13, x: 40, y: 10, w: 20, h: 8 },
          { str: "2.16", start: 13, end: 17, x: 62, y: 10, w: 16, h: 8 },
          { str: "92.11", start: 25, end: 30, x: 100, y: 10, w: 20, h: 8 },
          { str: "0.975", start: 38, end: 43, x: 140, y: 10, w: 22, h: 8 },
          { str: "0.940 ± 0.027", start: 55, end: 68, x: 180, y: 10, w: 50, h: 8 },
        ],
      },
    ];
    assert.equal(locateQuoteInPages(pages, "92.1").length, 0);
    assert.equal(locateQuoteInPages(pages, "92.11")[0]?.quote, "92.11");
    assert.equal(locateQuoteInPages(pages, "0.975")[0]?.quote, "0.975");
    assert.equal(locateQuoteInPages(pages, "95.59")[0]?.quote, "95.59");
    // "0.94" expands through trailing printed zero to "0.940"
    assert.equal(locateQuoteInPages(pages, "0.94")[0]?.quote, "0.940");
    const cell = offsetsToRects(pages[0]!, 8, 13);
    assert.equal(cell.length, 1);
    assert.ok(cell[0]!.w >= 20);
    assert.equal(cell[0]!.orient, "h");
  });

  it("detects vertical stacked table glyphs as a column cell", () => {
    const pages: PdfTextPage[] = [
      {
        page: 1,
        width: 400,
        height: 400,
        text: "95.59",
        items: [
          { str: "95", start: 0, end: 2, x: 200, y: 120, w: 10, h: 10, rotated: true },
          { str: ".", start: 2, end: 3, x: 200, y: 110, w: 3, h: 10, rotated: true },
          { str: "59", start: 3, end: 5, x: 200, y: 100, w: 10, h: 10, rotated: true },
        ],
      },
    ];
    const cell = offsetsToRects(pages[0]!, 0, 5);
    assert.equal(cell.length, 1);
    assert.equal(cell[0]!.orient, "v");
    assert.ok(cell[0]!.h > cell[0]!.w);
  });

  it("maps a page bbox to intersecting text highlights", async () => {
    const { highlightsFromPageRect } = await import("./pdfText.js");
    const page: PdfTextPage = {
      page: 1,
      width: 400,
      height: 400,
      text: "hello AUROC 0.94 world",
      items: [
        { str: "hello ", start: 0, end: 6, x: 10, y: 10, w: 30, h: 10 },
        { str: "AUROC 0.94", start: 6, end: 16, x: 100, y: 40, w: 50, h: 10 },
        { str: " world", start: 16, end: 22, x: 200, y: 80, w: 30, h: 10 },
      ],
    };
    const hits = highlightsFromPageRect(page, { x: 95, y: 35, w: 60, h: 20 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.quote, "AUROC 0.94");
  });

  it("clips horizontal number substrings and builds AABB from rotated transforms", async () => {
    const { transformItemBounds } = await import("./pdfText.js");
    // 90°: text advances on +Y, font height on −X (AHDMIL-style).
    const box = transformItemBounds([0, 10, -10, 0, 494.136, 506.525], 26.194, 10, 792);
    assert.ok(box.rotated);
    assert.ok(Math.abs(box.w - 10) < 0.5);
    assert.ok(Math.abs(box.h - 26.194) < 0.5);
    const pages: PdfTextPage[] = [
      {
        page: 1,
        width: 200,
        height: 200,
        text: "0.940 ± 0.027",
        items: [{ str: "0.940 ± 0.027", start: 0, end: 13, x: 100, y: 50, w: 65, h: 10 }],
      },
    ];
    const clipped = offsetsToRects(pages[0]!, 0, 5); // "0.940"
    assert.equal(clipped.length, 1);
    assert.ok(clipped[0]!.w < 40, `expected tight clip, got w=${clipped[0]!.w}`);
    assert.equal(clipped[0]!.orient, "h");
  });

  it("reports capability for PDF with text", async () => {
    const cap = await getFactsCapability(citekey);
    assert.equal(cap.ok, true);
  });

  it("creates facts of each type with highlights via mocked retrieve", async () => {
    const quote1 = "The proposed model outperforms TransMIL on TCGA-NSCLC with AUROC 0.91.";
    const quote2 = "Proposition 3.1 (Convergence Theorem)";

    const statement = await createFact(
      citekey,
      { type: "statement", input: "The proposed model outperforms TransMIL on TCGA-NSCLC" },
      {
        retrieve: async () => ({ answer: "supported", quotes: [quote1] }),
      },
    );
    assert.equal(statement.type, "statement");
    assert.equal(statement.answer, "supported");
    assert.equal(statement.status, "unreviewed");
    assert.ok(statement.highlights.length >= 1);
    assert.equal(statement.highlights[0]!.page, 1);
    assert.ok(statement.displayRects.length >= 1);

    const value = await createFact(
      citekey,
      { type: "value", input: "AUROC of the proposed model on TCGA-NSCLC" },
      { retrieve: async () => ({ answer: "0.91", quotes: ["AUROC 0.91"] }) },
    );
    assert.equal(value.answer, "0.91");
    assert.equal(value.status, "unreviewed");
    assert.ok(value.highlights.length >= 1);

    const question = await createFact(
      citekey,
      { type: "question", input: "What AUROC is reported on TCGA-NSCLC?" },
      {
        retrieve: async () => ({
          answer: "0.91",
          quotes: ["outperforms TransMIL on TCGA-NSCLC with AUROC 0.91"],
        }),
      },
    );
    assert.equal(question.answer, "0.91");
    assert.ok(question.highlights.length >= 1);

    const tag = await createFact(
      citekey,
      { type: "tag", input: "Proposition 3.1, Convergence Theorem" },
      { retrieve: async () => ({ answer: "", quotes: [quote2] }) },
    );
    assert.equal(tag.answer, "");
    assert.equal(tag.highlights[0]!.page, 2);

    const listed = await listFacts(citekey);
    assert.ok(listed.length >= 4);
  });

  it("human-tags a fact via rect and auto-confirms; untag keeps status", async () => {
    const fact = await createFact(citekey, {
      type: "value",
      input: "AUROC of demo model",
      answer: "0.91",
      rect: { page: 1, x: 70, y: 95, w: 420, h: 20 },
    });
    assert.equal(fact.status, "confirmed");
    assert.ok(fact.highlights.length >= 1);
    assert.match(fact.highlights[0]!.quote, /0\.91/);

    const retagged = await updateFact(citekey, fact.id, {
      rect: { page: 1, x: 70, y: 95, w: 420, h: 20 },
    });
    assert.equal(retagged.status, "confirmed");

    const n = await untagAllFacts(citekey);
    assert.ok(n >= 1);
    const listed = await listFacts(citekey);
    const again = listed.find((f) => f.id === fact.id);
    assert.ok(again);
    assert.equal(again!.highlights.length, 0);
    assert.equal(again!.status, "confirmed");
    assert.equal(again!.answer, "0.91");
  });

  it("marks unmatched quotes as not_found", async () => {
    const fact = await createFact(
      citekey,
      { type: "question", input: "What is the secret sauce?" },
      { retrieve: async () => ({ answer: "42", quotes: ["this text is not in the pdf at all"] }) },
    );
    assert.equal(fact.status, "not_found");
    assert.equal(fact.highlights.length, 0);
  });

  it("supports confirm, reject, edit, delete and library filters", async () => {
    const fact = await createFact(
      citekey,
      { type: "statement", input: "Model beats TransMIL" },
      {
        retrieve: async () => ({
          answer: "supported",
          quotes: ["outperforms TransMIL on TCGA-NSCLC"],
        }),
      },
    );
    const confirmed = await updateFact(citekey, fact.id, { status: "confirmed" });
    assert.equal(confirmed.status, "confirmed");

    const rejected = await updateFact(citekey, fact.id, {
      status: "rejected",
      rejectReason: "Wrong metric — accuracy instead of AUC",
    });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.rejectReason, "Wrong metric — accuracy instead of AUC");

    const edited = await updateFact(
      citekey,
      fact.id,
      { input: "Model beats TransMIL on NSCLC" },
      {
        retrieve: async () => ({
          answer: "supported",
          quotes: ["outperforms TransMIL on TCGA-NSCLC"],
        }),
      },
    );
    assert.equal(edited.input, "Model beats TransMIL on NSCLC");
    assert.equal(edited.status, "unreviewed");

    const answerEdit = await updateFact(citekey, fact.id, { answer: "not_supported" });
    assert.equal(answerEdit.answer, "not_supported");
    assert.equal(answerEdit.status, "unreviewed");

    const filtered = await listAllFacts({
      citekey,
      type: "statement",
      status: "unreviewed",
      q: "NSCLC",
    });
    assert.ok(filtered.some((f) => f.id === fact.id));
    assert.equal(filtered[0]!.paperTitle.length > 0, true);

    await deleteFact(citekey, fact.id);
    assert.equal(
      (await listFacts(citekey)).some((f) => f.id === fact.id),
      false,
    );
  });

  it("assigns unique keys and parses numeric values on create", async () => {
    const a = await createFact(
      citekey,
      { type: "value", input: "AUROC of ResGAT on TCGA", answer: "0.880 ± 0.057" },
      { retrieve: async () => ({ answer: "0.880 ± 0.057", quotes: ["AUROC 0.91"] }) },
    );
    assert.ok(a.key);
    assert.match(a.key!, /^[a-z][a-z0-9-]{1,63}$/);
    assert.equal(a.value, 0.88);
    const b = await createFact(
      citekey,
      { type: "value", input: "AUROC of ResGAT on TCGA", answer: "88%" },
      { retrieve: async () => ({ answer: "88%", quotes: ["AUROC 0.91"] }) },
    );
    assert.notEqual(a.key, b.key);
    assert.equal(b.value, 0.88);
    assert.equal(b.unit, "%");
  });

  it("lazily migrates an old facts.json without keys", async () => {
    const dir = path.join(libraryRoot, "papers", citekey);
    const file = path.join(dir, "facts.json");
    fs.writeFileSync(
      file,
      `${JSON.stringify(
        {
          version: 1,
          facts: [
            {
              id: "fact_legacy01",
              citekey,
              type: "value",
              input: "Legacy AUROC figure",
              answer: "1,250",
              highlights: [],
              status: "confirmed",
              createdAt: "2024-01-01T00:00:00.000Z",
              updatedAt: "2024-01-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const listed = await listFacts(citekey);
    const legacy = listed.find((f) => f.id === "fact_legacy01");
    assert.ok(legacy?.key);
    assert.equal(legacy!.value, 1250);
    assert.ok(fs.existsSync(`${file}.bak`));
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as {
      facts: Array<{ id: string; key?: string; value?: number }>;
    };
    assert.equal(persisted.facts.find((f) => f.id === "fact_legacy01")?.key, legacy!.key);
  });

  it("resets confirmed status when answer changes unless confirmWithContent", async () => {
    const fact = await createFact(
      citekey,
      { type: "value", input: "Fee per read", answer: "412.5" },
      { retrieve: async () => ({ answer: "412.5", quotes: ["AUROC 0.91"] }) },
    );
    await updateFact(citekey, fact.id, { status: "confirmed" });
    const edited = await updateFact(citekey, fact.id, { answer: "500" });
    assert.equal(edited.status, "unreviewed");
    assert.equal(edited.value, 500);
    const kept = await updateFact(citekey, fact.id, {
      answer: "510",
      status: "confirmed",
      confirmWithContent: true,
    });
    assert.equal(kept.status, "confirmed");
    assert.equal(kept.value, 510);
  });
});
