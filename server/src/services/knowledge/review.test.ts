import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-review-proj-"));
const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-review-lib-"));
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;
process.env.OPENLEAF_LIBRARY_ROOT = libraryRoot;

const { loadConfig } = await import("../../config.js");
loadConfig(true);

const { createKnowledgeItem } = await import("./items.js");
const { writeFile, writeProjectConfig } = await import("../projectFs.js");
const { hashStepBody, listStepStatuses, readReviewFile, reviewStep } = await import("./review.js");
const { createFact, updateFact } = await import("../library/facts.js");
const { addPaper, upsertCollection } = await import("../library/index.js");

describe("review.json service", () => {
  let projectId = "";
  let citekey = "";
  let factKey = "review-fee";

  before(async () => {
    await upsertCollection("demo", "demo");
    const paper = await addPaper({
      title: "DEMO review source",
      source: "manual",
      collections: ["demo"],
    });
    citekey = paper.citekey;
    const dir = path.join(libraryRoot, "papers", citekey);
    fs.mkdirSync(dir, { recursive: true });
    // Attach a minimal PDF-less source: create fact via human highlights needs source text.
    // Use web snapshot path instead.
    fs.writeFileSync(path.join(dir, "snapshot.txt"), "The DEMO fee is 10 USD.");
    fs.writeFileSync(
      path.join(dir, "snapshot.json"),
      JSON.stringify({ url: "https://example.invalid", fetchedAt: new Date().toISOString(), sha256: "x", title: "t", bytes: 20 }),
    );
    const recPath = path.join(dir, "record.json");
    const rec = JSON.parse(fs.readFileSync(recPath, "utf8")) as Record<string, unknown>;
    rec.source = "web";
    rec.url = "https://example.invalid";
    fs.writeFileSync(recPath, `${JSON.stringify(rec, null, 2)}\n`);

    const fact = await createFact(citekey, {
      type: "value",
      input: "DEMO fee",
      answer: "10",
      key: factKey,
      value: 10,
      unit: "USD",
      sourceKind: "web",
      highlights: [{ page: 1, start: 0, end: 22, quote: "The DEMO fee is 10 USD." }],
    });
    factKey = fact.key!;
    await updateFact(citekey, fact.id, { status: "confirmed", confirmWithContent: true });

    const item = await createKnowledgeItem({
      title: "DEMO review item",
      knowledgeId: "demo-review-item",
      collection: "demo",
    });
    projectId = item.project.id;
    await writeFile(
      projectId,
      "main.tex",
      `\\documentclass{article}
\\usepackage{openleaf-knowledge}
\\begin{document}
\\begin{knowledge}[result=total]{DEMO review item}
\\begin{calculation}{total}
\\fact{${factKey}}
\\end{calculation}
\\conclusion{Total \\out{total}.}
\\end{knowledge}
\\end{document}
`,
    );
    await writeProjectConfig(projectId, {
      name: "DEMO review item",
      kind: "knowledge",
      knowledgeId: "demo-review-item",
      collection: "demo",
      mainFile: "main.tex",
    });
  });

  after(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  });

  it("marks steps needs-review until reviewed; editing returns to needs-review", async () => {
    let steps = await listStepStatuses(projectId);
    const calc = steps.find((s) => s.id === "calculation:total");
    assert.ok(calc);
    assert.equal(calc.status, "needs-review");

    await reviewStep(projectId, "calculation:total", "reviewed", "tester");
    steps = await listStepStatuses(projectId);
    assert.equal(steps.find((s) => s.id === "calculation:total")?.status, "reviewed");

    const tex = fs.readFileSync(path.join(projectsRoot, projectId, "main.tex"), "utf8");
    fs.writeFileSync(
      path.join(projectsRoot, projectId, "main.tex"),
      tex.replace(`\\fact{${factKey}}`, `\\fact{${factKey}} + 0`),
    );
    steps = await listStepStatuses(projectId);
    assert.equal(steps.find((s) => s.id === "calculation:total")?.status, "needs-review");
  });

  it("hand-edited review.json cannot mark changed text as reviewed", async () => {
    await reviewStep(projectId, "calculation:total", "reviewed", "tester");
    const file = await readReviewFile(projectId);
    const step = file.steps["calculation:total"];
    assert.ok(step);
    // Forge a matching hash for wrong body — service re-hashes live text
    step.hash = hashStepBody("totally different body");
    fs.writeFileSync(
      path.join(projectsRoot, projectId, "review.json"),
      `${JSON.stringify(file, null, 2)}\n`,
    );
    const steps = await listStepStatuses(projectId);
    assert.equal(steps.find((s) => s.id === "calculation:total")?.status, "needs-review");
  });

  it("rejecting a fact flags the reviewed step", async () => {
    // Restore clean body + review
    await writeFile(
      projectId,
      "main.tex",
      `\\documentclass{article}
\\usepackage{openleaf-knowledge}
\\begin{document}
\\begin{knowledge}[result=total]{DEMO review item}
\\begin{calculation}{total}
\\fact{${factKey}}
\\end{calculation}
\\conclusion{Total \\out{total}.}
\\end{knowledge}
\\end{document}
`,
    );
    await reviewStep(projectId, "calculation:total", "reviewed", "tester");
    const facts = JSON.parse(
      fs.readFileSync(path.join(libraryRoot, "papers", citekey, "facts.json"), "utf8"),
    ) as { facts: Array<{ id: string; key?: string }> };
    const f = facts.facts.find((x) => x.key === factKey)!;
    await updateFact(citekey, f.id, {
      status: "rejected",
      rejectReason: "Wrong number for the test",
    });
    const steps = await listStepStatuses(projectId);
    const calc = steps.find((s) => s.id === "calculation:total");
    assert.equal(calc?.status, "flagged");
    assert.ok(calc?.why.some((w) => /rejected/.test(w)));

    await assert.rejects(
      () => reviewStep(projectId, "calculation:total", "reviewed", "tester"),
      (err: unknown) => {
        assert.ok(err && typeof err === "object" && "status" in err && (err as { status: number }).status === 409);
        return true;
      },
    );
  });
});
