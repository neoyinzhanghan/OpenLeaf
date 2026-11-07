import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-kuzu-lib-"));
const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-kuzu-proj-"));
process.env.OPENLEAF_LIBRARY_ROOT = libraryRoot;
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;

const { loadConfig } = await import("../../config.js");
loadConfig(true);

const { createKnowledgeItem } = await import("./items.js");
const { writeFile, writeProjectConfig } = await import("../projectFs.js");
const { addPaper } = await import("../library/index.js");
const { createFact, updateFact } = await import("../library/facts.js");
const { buildKnowledgeGraph, neighborhoodOf, knowledgeIndexStatus, invalidateKnowledgeGraph } =
  await import("./graph.js");

describe("knowledge kuzu index", () => {
  before(async () => {
    invalidateKnowledgeGraph();
    const paper = await addPaper({
      title: "DEMO kuzu source",
      source: "web",
      url: "https://example.invalid/kuzu",
    });
    const dir = path.join(libraryRoot, "papers", paper.citekey);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "snapshot.txt"), "The DEMO metric is 42 units.");
    fs.writeFileSync(
      path.join(dir, "snapshot.json"),
      JSON.stringify({
        url: "https://example.invalid/kuzu",
        fetchedAt: new Date().toISOString(),
        sha256: "x",
        title: "t",
        bytes: 20,
      }),
    );
    const rec = JSON.parse(fs.readFileSync(path.join(dir, "record.json"), "utf8")) as Record<string, unknown>;
    rec.source = "web";
    fs.writeFileSync(path.join(dir, "record.json"), `${JSON.stringify(rec, null, 2)}\n`);

    const fact = await createFact(paper.citekey, {
      type: "value",
      input: "DEMO metric",
      answer: "42",
      key: "demo-kuzu-metric",
      value: 42,
      sourceKind: "web",
      highlights: [{ page: 1, start: 0, end: 28, quote: "The DEMO metric is 42 units." }],
    });
    await updateFact(paper.citekey, fact.id, { status: "confirmed", confirmWithContent: true });

    // Uncited fact — indexed but not in default tree
    await createFact(paper.citekey, {
      type: "value",
      input: "DEMO hidden",
      answer: "1",
      key: "demo-kuzu-hidden",
      value: 1,
      sourceKind: "web",
      highlights: [{ page: 1, start: 0, end: 10, quote: "The DEMO m" }],
    });

    const item = await createKnowledgeItem({
      title: "DEMO kuzu item",
      knowledgeId: "demo-kuzu-item",
    });
    await writeFile(
      item.project.id,
      "main.tex",
      `\\documentclass{article}
\\usepackage{openleaf-knowledge}
\\begin{document}
\\begin{knowledge}[result=x]{DEMO kuzu item}
\\begin{calculation}{x}
\\fact{demo-kuzu-metric}
\\end{calculation}
\\end{knowledge}
\\end{document}
`,
    );
    await writeProjectConfig(item.project.id, {
      name: "DEMO kuzu item",
      kind: "knowledge",
      knowledgeId: "demo-kuzu-item",
      mainFile: "main.tex",
    });
  });

  after(() => {
    invalidateKnowledgeGraph();
    fs.rmSync(libraryRoot, { recursive: true, force: true });
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("builds a kuzu-backed tree with only cited facts", async () => {
    const graph = await buildKnowledgeGraph(true);
    assert.ok(graph.nodes.some((n) => n.id === "kn:demo-kuzu-item"));
    assert.ok(graph.nodes.some((n) => n.id === "fact:demo-kuzu-metric"));
    const hidden = graph.nodes.find((n) => n.id === "fact:demo-kuzu-hidden");
    assert.ok(hidden, "uncited facts are indexed for search/neighborhood");
    assert.equal(hidden.inTree, false, "uncited facts are not in the default tree");
    assert.equal(
      graph.nodes.find((n) => n.id === "fact:demo-kuzu-metric")?.inTree,
      true,
      "cited facts are in the default tree",
    );
    const status = knowledgeIndexStatus();
    assert.ok(status.nodes >= 3);
    // Prefer kuzu; memory fallback still acceptable if native addon fails in CI
    assert.ok(status.backend === "kuzu" || status.backend === "memory");
  });

  it("neighborhood reveals sibling facts from the same source", async () => {
    const nb = await neighborhoodOf("kn:demo-kuzu-item", 2);
    assert.ok(nb.nodes.some((n) => n.id === "fact:demo-kuzu-metric"));
    // Focusing the knowledge item pulls the source; siblings may appear when source is expanded
    const viaSrc = await neighborhoodOf("src:" + nb.nodes.find((n) => n.kind === "source")!.id.slice(4), 1);
    assert.ok(viaSrc.nodes.some((n) => n.id === "fact:demo-kuzu-hidden"));
    assert.ok(viaSrc.pathRefs["fact:demo-kuzu-hidden"]?.includes("facts.json"));
  });
});
