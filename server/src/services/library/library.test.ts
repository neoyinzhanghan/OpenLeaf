import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-library-"));
process.env.OPENLEAF_LIBRARY_ROOT = libraryRoot;

const { loadConfig } = await import("../../config.js");
loadConfig(true);

const {
  addPaper,
  closeIndexDb,
  deletePaper,
  findByDoi,
  getPaper,
  readCollections,
  reindexLibrary,
  searchPapers,
  updatePaper,
  upsertCollection,
} = await import("./index.js");

describe("library data layer", () => {
  before(async () => {
    await reindexLibrary();
  });

  after(() => {
    closeIndexDb();
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  });

  it("adds a paper as papers/<citekey>/record.json", async () => {
    const paper = await addPaper({
      title: "Attention Is All You Need",
      authors: [{ given: "Ashish", family: "Vaswani" }],
      year: 2017,
      doi: "10.5555/3295222.3295349",
      tags: ["transformers", "nlp"],
      source: "manual",
    });
    assert.equal(paper.citekey, "vaswani2017attention");
    assert.equal(paper.integrity.existence, "unresolved");
    assert.ok(fs.existsSync(path.join(libraryRoot, "papers", paper.citekey, "record.json")));

    const loaded = await getPaper(paper.citekey);
    assert.equal(loaded.title, "Attention Is All You Need");
    assert.equal(loaded.doi, "10.5555/3295222.3295349");
  });

  it("dedupes by DOI on add", async () => {
    await assert.rejects(
      () =>
        addPaper({
          title: "Duplicate",
          doi: "10.5555/3295222.3295349",
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { status?: number }).status, 409);
        return true;
      },
    );
  });

  it("finds by DOI and searches via FTS", async () => {
    const byDoi = await findByDoi("10.5555/3295222.3295349");
    assert.ok(byDoi);
    assert.equal(byDoi!.citekey, "vaswani2017attention");

    const hits = await searchPapers({ q: "attention transformers" });
    assert.ok(hits.some((p) => p.citekey === "vaswani2017attention"));

    const tagged = await searchPapers({ tag: "nlp" });
    assert.ok(tagged.some((p) => p.citekey === "vaswani2017attention"));
  });

  it("updates notes/tags and rebuilds index after delete+reindex", async () => {
    const updated = await updatePaper("vaswani2017attention", {
      notes: "Seminal transformer paper",
      tags: ["transformers", "nlp", "classic"],
    });
    assert.equal(updated.notes, "Seminal transformer paper");
    assert.ok(updated.tags.includes("classic"));

    const second = await addPaper({
      citekey: "smith2023attention",
      title: "Another Attention Paper",
      year: 2023,
      authors: [{ given: "Jane", family: "Smith" }],
    });
    assert.equal(second.citekey, "smith2023attention");

    await deletePaper("smith2023attention");
    await assert.rejects(() => getPaper("smith2023attention"), (err: unknown) => {
      assert.equal((err as { status?: number }).status, 404);
      return true;
    });

    const { count } = await reindexLibrary();
    assert.equal(count, 1);
  });

  it("manages collections.json", async () => {
    const coll = await upsertCollection("ml", "Machine Learning");
    assert.equal(coll.collections.ml?.name, "Machine Learning");
    const read = await readCollections();
    assert.equal(read.collections.ml?.name, "Machine Learning");

    await updatePaper("vaswani2017attention", { collections: ["ml"] });
    const inColl = await searchPapers({ collection: "ml" });
    assert.equal(inColl.length, 1);
  });
});
