import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-claim-lib-"));
const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-claim-proj-"));
process.env.OPENLEAF_LIBRARY_ROOT = libraryRoot;
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;

const { loadConfig } = await import("../../config.js");
loadConfig(true);

const { addPaper, closeIndexDb, reindexLibrary } = await import("./index.js");
const { createProject, writeFile } = await import("../projectFs.js");
const { setClaimCheckerForTests, createHeuristicClaimChecker } = await import("./claim-check.js");
const { scanProjectCitations, verifyClaimInstance, listCitationInstances } = await import("./citations.js");

describe("claim-support checking", () => {
  const projectId = "claim-demo";

  before(async () => {
    setClaimCheckerForTests(createHeuristicClaimChecker());
    await reindexLibrary();
    await createProject(projectId);
    await addPaper({
      citekey: "smith2023attention",
      title: "Attention Mechanisms for Label Shift",
      abstract:
        "We propose attention mechanisms that correct for label shift in classification. Experiments show improved calibration under shifted label distributions.",
      authors: [{ given: "Jane", family: "Smith" }],
      year: 2023,
    });
    await writeFile(
      projectId,
      "main.tex",
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "Attention mechanisms improve calibration under label shift \\cite{smith2023attention}.",
        "\\end{document}",
        "",
      ].join("\n"),
    );
  });

  after(() => {
    setClaimCheckerForTests(null);
    closeIndexDb();
    fs.rmSync(libraryRoot, { recursive: true, force: true });
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("scans \\cite instances into citations.json", async () => {
    const instances = await scanProjectCitations(projectId, ["main.tex"]);
    assert.equal(instances.length, 1);
    assert.equal(instances[0]!.citekey, "smith2023attention");
    assert.equal(instances[0]!.verdict, "not_checked");
    assert.ok(fs.existsSync(path.join(projectsRoot, projectId, "citations.json")));
  });

  it("verifies a claim with heuristic entailment and skips re-check on same hash", async () => {
    const first = await verifyClaimInstance(projectId, "main.tex", 3, {
      citekey: "smith2023attention",
      force: true,
    });
    assert.ok(["supporting", "mentioning", "unverifiable"].includes(first.verdict));
    assert.equal(first.flaggedForReview, true);
    assert.ok(first.checkedAt);

    const second = await verifyClaimInstance(projectId, "main.tex", 3, {
      citekey: "smith2023attention",
    });
    assert.equal(second.checkedAt, first.checkedAt);

    const all = await listCitationInstances(projectId);
    assert.equal(all.length, 1);
  });
});
