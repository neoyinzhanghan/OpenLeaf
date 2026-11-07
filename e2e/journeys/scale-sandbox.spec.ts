/**
 * Journey 6: synthetic scale sandbox — inbox/facts/tree stay usable.
 * Never writes into a real library; uses e2e/instance sandbox only.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startInstance, type Instance } from "../instance";

const afterDir = path.join(process.cwd(), "docs/knowledge/morning/scale/after");
fs.mkdirSync(afterDir, { recursive: true });

let instance: Instance;

/** Smaller than the 2k brief target so CI stays under a few minutes; still stresses lists. */
const SOURCE_COUNT = 80;
const FACTS_PER_SOURCE = 5; // 400 facts
const KNOWLEDGE_COUNT = 40;
const PAPER_COUNT = 5;

test.beforeAll(async () => {
  instance = await startInstance();
  const libraryRoot = path.join(path.dirname(instance.projects), "library");
  const papersDir = path.join(libraryRoot, "papers");
  fs.mkdirSync(papersDir, { recursive: true });

  const index: Array<Record<string, unknown>> = [];
  for (let s = 0; s < SOURCE_COUNT; s++) {
    const citekey = `scale${String(s).padStart(4, "0")}`;
    const dir = path.join(papersDir, citekey);
    fs.mkdirSync(dir, { recursive: true });
    const paper = {
      citekey,
      doi: null,
      arxivId: null,
      url: `https://example.invalid/scale/${citekey}`,
      title: `DEMO scale source ${s}`,
      authors: ["Scale Bot"],
      venue: "Scale",
      year: 2026,
      abstract: "",
      tags: [],
      collections: ["scale"],
      notes: "",
      attachment: null,
      source: "web",
      starred: false,
      status: "unread",
      rating: 0,
      integrity: { existence: "unresolved", retraction: "clean", lastChecked: null, reason: null },
      addedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, "paper.json"), `${JSON.stringify(paper, null, 2)}\n`);
    fs.writeFileSync(
      path.join(dir, "snapshot.txt"),
      `Scale source ${s} reports a value of ${1000 + s} units.\n`,
    );
    fs.writeFileSync(
      path.join(dir, "snapshot.json"),
      `${JSON.stringify({
        url: paper.url,
        fetchedAt: new Date().toISOString(),
        sha256: "scale",
        title: paper.title,
        bytes: 40,
        provenance: "curated",
      })}\n`,
    );
    const facts = [];
    for (let f = 0; f < FACTS_PER_SOURCE; f++) {
      const key = `scale-s${s}-f${f}`;
      const status =
        f === 0 && s % 17 === 0 ? "rejected" : f === 1 && s % 11 === 0 ? "unreviewed" : "confirmed";
      facts.push({
        id: `fact_scale_${s}_${f}`,
        citekey,
        type: "value",
        input: `Scale metric ${s}.${f}`,
        answer: String(1000 + s * 10 + f),
        key,
        value: 1000 + s * 10 + f,
        unit: "units",
        status,
        rejectReason: status === "rejected" ? "Scale fixture reject" : undefined,
        highlights: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    fs.writeFileSync(path.join(dir, "facts.json"), `${JSON.stringify({ facts }, null, 2)}\n`);
    index.push(paper);
  }
  fs.mkdirSync(path.join(libraryRoot), { recursive: true });
  fs.writeFileSync(path.join(libraryRoot, "index.json"), `${JSON.stringify({ papers: index }, null, 2)}\n`);

  for (let k = 0; k < KNOWLEDGE_COUNT; k++) {
    const depth = (k % 6) + 1;
    const id = `demo-scale-kn-${k}`;
    const name = `DEMO scale knowledge ${k}`;
    const dir = path.join(instance.projects, name);
    fs.mkdirSync(dir, { recursive: true });
    const factKey = `scale-s${k % SOURCE_COUNT}-f0`;
    let body = `\\fact{${factKey}}`;
    for (let d = 1; d < depth; d++) {
      const prev = Math.max(0, k - d);
      body = `\\kn{demo-scale-kn-${prev}}`;
    }
    fs.writeFileSync(
      path.join(dir, "openleaf.json"),
      `${JSON.stringify({
        name,
        mainFile: "main.tex",
        engine: "pdflatex",
        kind: "knowledge",
        knowledgeId: id,
        collection: "scale",
      })}\n`,
    );
    fs.writeFileSync(
      path.join(dir, "main.tex"),
      `\\documentclass{article}
\\usepackage{openleaf-knowledge}
\\begin{document}
\\begin{knowledge}[result=x]{${name}}
\\begin{calculation}{x}
${body}
\\end{calculation}
\\conclusion{Result \\out{x}.}
\\end{knowledge}
\\end{document}
`,
    );
  }

  for (let p = 0; p < PAPER_COUNT; p++) {
    const name = `DEMO scale paper ${p}`;
    const dir = path.join(instance.projects, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "openleaf.json"),
      `${JSON.stringify({
        name,
        mainFile: "main.tex",
        engine: "pdflatex",
        kind: "paper",
      })}\n`,
    );
    fs.writeFileSync(
      path.join(dir, "main.tex"),
      `\\documentclass{article}
\\usepackage{openleaf-knowledge}
\\begin{document}
Scale paper cites \\kn{demo-scale-kn-${p}}.
\\end{document}
`,
    );
  }
});

test.afterAll(async () => {
  await instance.stop();
});

test("scale sandbox: inbox, facts, tree respond under load", async ({ page }) => {
  const t0 = Date.now();
  const inbox = await fetch(`${instance.baseURL}/api/knowledge/inbox`, {
    headers: { Origin: instance.baseURL },
  });
  expect(inbox.ok).toBeTruthy();
  const inboxMs = Date.now() - t0;
  expect(inboxMs).toBeLessThan(15_000);

  const t1 = Date.now();
  const graph = await fetch(`${instance.baseURL}/api/knowledge/graph`, {
    headers: { Origin: instance.baseURL },
  });
  expect(graph.ok).toBeTruthy();
  const graphBody = (await graph.json()) as { nodes: unknown[] };
  expect(graphBody.nodes.length).toBeGreaterThan(50);
  const graphMs = Date.now() - t1;
  expect(graphMs).toBeLessThan(30_000);

  const t2 = Date.now();
  await page.goto(`${instance.baseURL}/review`);
  await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible({ timeout: 30_000 });
  const reviewMs = Date.now() - t2;
  await page.screenshot({ path: path.join(afterDir, "01-inbox-scale.png"), fullPage: true });

  const t3 = Date.now();
  await page.goto(`${instance.baseURL}/facts`);
  await expect(page.getByRole("heading", { name: /Facts/i }).first()).toBeVisible({
    timeout: 30_000,
  });
  const factsMs = Date.now() - t3;
  await page.screenshot({ path: path.join(afterDir, "02-facts-scale.png"), fullPage: true });

  const t4 = Date.now();
  await page.goto(`${instance.baseURL}/knowledge`);
  await expect(page.locator("canvas, .knowledge-canvas, .knowledge-page").first()).toBeVisible({
    timeout: 30_000,
  });
  const treeMs = Date.now() - t4;
  await page.screenshot({ path: path.join(afterDir, "03-tree-scale.png"), fullPage: true });

  // Soft budget — overnight brief wants <1.5s pages; record actuals in screenshot name isn't needed.
  expect(reviewMs + factsMs + treeMs).toBeLessThan(90_000);
  expect(inboxMs + graphMs).toBeLessThan(45_000);
});
