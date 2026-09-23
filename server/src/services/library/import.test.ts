import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-lib-import-"));
process.env.OPENLEAF_LIBRARY_ROOT = libraryRoot;

const { loadConfig } = await import("../../config.js");
loadConfig(true);

const { setSourceClientsForTests } = await import("./sources/index.js");
const { closeIndexDb, reindexLibrary, findByDoi } = await import("./index.js");
const { detectLink, importBibtex, importFromLink, importPdf, extractPdfTitle } = await import("./import.js");
const { parseBibtex } = await import("./bibtex.js");

const mockResolved = {
  doi: "10.1000/test.doi",
  arxivId: null,
  url: "https://doi.org/10.1000/test.doi",
  title: "Mock Paper Title",
  authors: [{ given: "Ada", family: "Lovelace" }],
  venue: "Journal of Tests",
  year: 2024,
  abstract: "A mock abstract.",
  source: "doi" as const,
};

describe("import flows", () => {
  before(async () => {
    setSourceClientsForTests({
      crossref: {
        lookupDoi: async (doi) =>
          doi.includes("10.1000")
            ? { ...mockResolved, doi, title: doi.includes("pdf") ? "Mock Embedded Title" : mockResolved.title }
            : null,
      },
      openalex: {
        lookupDoi: async () => null,
        searchByTitle: async (title) => {
          if (title.toLowerCase().includes("embedded")) {
            return {
              ...mockResolved,
              doi: "10.1000/pdf.embedded",
              title: "Mock Embedded Title",
              source: "manual" as const,
            };
          }
          if (title.toLowerCase().includes("mock")) {
            return { ...mockResolved, source: "manual" as const };
          }
          return null;
        },
      },
      arxiv: {
        lookupId: async (id) =>
          id.startsWith("2401")
            ? {
                ...mockResolved,
                doi: null,
                arxivId: id,
                source: "arxiv" as const,
                title: "Arxiv Mock",
              }
            : null,
      },
    });
    await reindexLibrary();
  });

  after(() => {
    setSourceClientsForTests(null);
    closeIndexDb();
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  });

  it("detects DOI, arXiv, and PubMed links", () => {
    assert.equal(detectLink("10.1000/test.doi").kind, "doi");
    assert.equal(detectLink("https://doi.org/10.1000/test.doi").kind, "doi");
    assert.equal(detectLink("https://arxiv.org/abs/2401.01234").kind, "arxiv");
    assert.equal(detectLink("2401.01234").kind, "arxiv");
    assert.equal(detectLink("https://pubmed.ncbi.nlm.nih.gov/12345/").kind, "pubmed");
  });

  it("imports from a DOI link and dedupes on second import", async () => {
    const first = await importFromLink("https://doi.org/10.1000/test.doi");
    assert.equal(first.created, true);
    assert.equal((first.paper as { title: string }).title, "Mock Paper Title");
    const second = await importFromLink("10.1000/test.doi");
    assert.equal(second.created, false);
    assert.equal(second.existingCitekey, (first.paper as { citekey: string }).citekey);
  });

  it("imports from arXiv id", async () => {
    const result = await importFromLink("arxiv:2401.99999");
    assert.equal(result.created, true);
    assert.equal((result.paper as { arxivId: string | null }).arxivId, "2401.99999");
  });

  it("parses and bulk-imports BibTeX with DOI dedup", async () => {
    const bib = `
@article{otherkey2024,
  title={Mock Paper Title},
  author={Lovelace, Ada},
  year={2024},
  doi={10.1000/test.doi}
}
@article{fresh2024,
  title={A Fresh Paper},
  author={Turing, Alan},
  year={2024},
  journal={Tests}
}
`;
    const parsed = parseBibtex(bib);
    assert.equal(parsed.length, 2);
    const result = await importBibtex(bib);
    // Existing DOI → either skip, or create a citekey alias without a second DOI.
    const alias = result.imported.find((p) => p.citekey === "otherkey2024");
    if (alias) {
      assert.equal(alias.doi, null);
      assert.match(alias.notes, /alias of/i);
      assert.equal(result.skipped.length, 0);
    } else {
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0]!.reason, "doi-exists");
      assert.equal(result.skipped[0]!.match, "doi");
    }
    assert.ok(result.imported.some((p) => p.citekey === "fresh2024"));
    const byDoi = await findByDoi("10.1000/test.doi");
    assert.ok(byDoi);
  });

  it("skips BibTeX entries that soft-match an existing title + author", async () => {
    const bib = `
@article{dupetitle2024,
  title={Mock Paper Title: an extended abstract},
  author={Lovelace, Ada},
  year={2024}
}
`;
    const result = await importBibtex(bib);
    assert.equal(result.imported.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0]!.match, "title");
    assert.ok(result.skipped[0]!.existingCitekey);
  });

  it("extracts PDF title and imports via OpenAlex title search", async () => {
    // Minimal PDF with Info /Title
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj<< /Title (Mock Embedded Title) >>endobj\ntrailer<< /Info 1 0 R >>\n%%EOF\n",
      "latin1",
    );
    assert.equal(extractPdfTitle(pdf), "Mock Embedded Title");
    const result = await importPdf(pdf, { filename: "paper.pdf" });
    assert.equal(result.paper.doi, "10.1000/pdf.embedded", `unexpected: ${JSON.stringify(result)}`);
    assert.equal(result.created, true, `unexpected: ${JSON.stringify(result)}`);
    assert.ok(result.paper.attachment === "attachment.pdf");
    assert.ok(fs.existsSync(path.join(libraryRoot, "papers", result.paper.citekey, "attachment.pdf")));
    // Same DOI should attach without duplicating
    const again = await importPdf(pdf);
    assert.equal(again.created, false);
    const byDoi = await findByDoi("10.1000/pdf.embedded");
    assert.ok(byDoi);
  });
});
