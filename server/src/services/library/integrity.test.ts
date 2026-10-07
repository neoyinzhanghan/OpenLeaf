import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-integrity-"));
process.env.OPENLEAF_LIBRARY_ROOT = libraryRoot;

const { loadConfig } = await import("../../config.js");
loadConfig(true);

const { setSourceClientsForTests } = await import("./sources/index.js");
const { addPaper, closeIndexDb, getPaper, reindexLibrary } = await import("./index.js");
const { checkPaperIntegrity } = await import("./integrity.js");

describe("integrity checks", () => {
  before(async () => {
    setSourceClientsForTests({
      crossref: {
        lookupDoi: async (doi) =>
          doi === "10.1000/good"
            ? {
                doi,
                arxivId: null,
                url: `https://doi.org/${doi}`,
                title: "Good Paper",
                authors: [{ given: "A", family: "Author" }],
                venue: "Tests",
                year: 2020,
                abstract: "",
                source: "doi",
              }
            : doi === "10.1000/mismatch"
              ? {
                  doi,
                  arxivId: null,
                  url: `https://doi.org/${doi}`,
                  title: "Completely Different Remote Title",
                  authors: [],
                  venue: "",
                  year: 2020,
                  abstract: "",
                  source: "doi",
                }
              : null,
      },
      openalex: {
        lookupDoi: async () => null,
        searchByTitle: async () => null,
      },
      arxiv: { lookupId: async () => null },
    });
    await reindexLibrary();
  });

  after(() => {
    setSourceClientsForTests(null);
    closeIndexDb();
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  });

  it("marks verified + clean when Crossref finds the DOI", async () => {
    const paper = await addPaper({
      citekey: "good2020",
      title: "Good Paper",
      doi: "10.1000/good",
      year: 2020,
    });
    // Mock fetch for retraction endpoint
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("api.crossref.org/works/")) {
        return new Response(
          JSON.stringify({ message: { title: ["Good Paper"], "update-to": [] } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };
    const result = await checkPaperIntegrity(paper.citekey, { force: true, fetchImpl });
    assert.equal(result.integrity.existence, "verified");
    assert.equal(result.integrity.retraction, "clean");
    assert.ok(result.integrity.lastChecked);
    const stored = await getPaper(paper.citekey);
    assert.equal(stored.integrity.existence, "verified");
  });

  it("flags retracted via Crossref update-to", async () => {
    const paper = await addPaper({
      citekey: "bad2020",
      title: "Retracted Work",
      doi: "10.1000/retracted",
      year: 2020,
    });
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          message: {
            title: ["Retracted Work"],
            "update-to": [{ type: "retraction", DOI: "10.1000/retraction-notice" }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    // Override crossref metadata client so title match does not fail
    setSourceClientsForTests({
      crossref: {
        lookupDoi: async (doi) => ({
          doi,
          arxivId: null,
          url: `https://doi.org/${doi}`,
          title: "Retracted Work",
          authors: [],
          venue: "",
          year: 2020,
          abstract: "",
          source: "doi",
        }),
      },
      openalex: { lookupDoi: async () => null, searchByTitle: async () => null },
      arxiv: { lookupId: async () => null },
    });
    const result = await checkPaperIntegrity(paper.citekey, { force: true, fetchImpl });
    assert.equal(result.integrity.existence, "verified");
    assert.equal(result.integrity.retraction, "retracted");
  });

  it("flags title mismatch against Crossref metadata", async () => {
    const paper = await addPaper({
      citekey: "mismatch2020",
      title: "Local Title That Differs",
      doi: "10.1000/mismatch",
      year: 2020,
    });
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ message: { title: ["Completely Different Remote Title"] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    setSourceClientsForTests({
      crossref: {
        lookupDoi: async (doi) => ({
          doi,
          arxivId: null,
          url: `https://doi.org/${doi}`,
          title: "Completely Different Remote Title",
          authors: [],
          venue: "",
          year: 2020,
          abstract: "",
          source: "doi",
        }),
      },
      openalex: { lookupDoi: async () => null, searchByTitle: async () => null },
      arxiv: { lookupId: async () => null },
    });
    const result = await checkPaperIntegrity(paper.citekey, { force: true, fetchImpl });
    assert.equal(result.integrity.existence, "mismatch");
  });
});
