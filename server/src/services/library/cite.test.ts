import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-cite-lib-"));
const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-cite-proj-"));
process.env.OPENLEAF_LIBRARY_ROOT = libraryRoot;
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;

const { loadConfig } = await import("../../config.js");
loadConfig(true);

const { addPaper, closeIndexDb, reindexLibrary } = await import("./index.js");
const { createProject } = await import("../projectFs.js");
const { citeIntoProject, paperToBibtex } = await import("./cite.js");
const { readFile } = await import("../projectFs.js");

describe("cite into project", () => {
  const projectId = "cite-demo";

  before(async () => {
    await reindexLibrary();
    await createProject(projectId);
    await addPaper({
      citekey: "smith2023attention",
      title: "Attention Revisited",
      authors: [{ given: "Jane", family: "Smith" }],
      year: 2023,
      doi: "10.1000/attention",
    });
  });

  after(() => {
    closeIndexDb();
    fs.rmSync(libraryRoot, { recursive: true, force: true });
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("renders a bibtex entry from a library record", () => {
    const bib = paperToBibtex({
      citekey: "smith2023attention",
      title: "Attention Revisited",
      authors: [{ given: "Jane", family: "Smith" }],
      year: 2023,
      doi: "10.1000/attention",
      arxivId: null,
      url: "https://doi.org/10.1000/attention",
      venue: "NeurIPS",
      abstract: "",
      tags: [],
      collections: [],
      notes: "",
      attachment: null,
      source: "manual",
      integrity: { existence: "unresolved", retraction: "clean", lastChecked: null },
      addedAt: new Date().toISOString(),
    });
    assert.match(bib, /@article\{smith2023attention,/);
    assert.match(bib, /doi = \{10\.1000\/attention\}/);
  });

  it("syncs into references.bib and inserts \\cite{}", async () => {
    await citeIntoProject(projectId, { citekey: "smith2023attention" });
    const bib = await readFile(projectId, "references.bib");
    assert.match(bib.content, /smith2023attention/);

    // Ensure main.tex exists with a line to cite into
    const main = await readFile(projectId, "main.tex");
    const lines = main.content.split("\n");
    const line = Math.min(5, lines.length);
    const result = await citeIntoProject(projectId, {
      citekey: "smith2023attention",
      file: "main.tex",
      line,
    });
    assert.equal(result.inserted, true);
    const updated = await readFile(projectId, "main.tex");
    assert.match(updated.content, /\\cite\{smith2023attention\}/);
  });
});
