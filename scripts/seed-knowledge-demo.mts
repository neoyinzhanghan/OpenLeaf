/**
 * Seed / remove Knowledge demo data. Every title contains "DEMO".
 * Usage: npx tsx scripts/seed-knowledge-demo.mts [--remove]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const remove = process.argv.includes("--remove");
const libraryRoot = process.env.OPENLEAF_LIBRARY_ROOT || path.join(root, "library");
const projectsRoot = process.env.OPENLEAF_PROJECTS_ROOT || path.join(root, "projects");

process.env.OPENLEAF_LIBRARY_ROOT = libraryRoot;
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;
process.env.OPENLEAF_ALLOW_PRIVATE_FETCH = "1";

const DEMO_COLLECTION = "demo-not-real-data";
const DEMO_PROJECTS = [
  "demo-us-market-size",
  "demo-us-aspirates",
  "demo-paper-citing-knowledge",
];

const { loadConfig } = await import("../server/src/config.ts");
loadConfig(true);

if (remove) {
  for (const id of DEMO_PROJECTS) {
    fs.rmSync(path.join(projectsRoot, id), { recursive: true, force: true });
  }
  const papers = path.join(libraryRoot, "papers");
  if (fs.existsSync(papers)) {
    for (const name of fs.readdirSync(papers)) {
      const recPath = path.join(papers, name, "record.json");
      if (!fs.existsSync(recPath)) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(recPath, "utf8")) as {
          title?: string;
          collections?: string[];
        };
        if (
          String(rec.title || "").includes("DEMO") ||
          (rec.collections || []).includes(DEMO_COLLECTION)
        ) {
          fs.rmSync(path.join(papers, name), { recursive: true, force: true });
        }
      } catch {
        /* ignore */
      }
    }
  }
  const collPath = path.join(libraryRoot, "collections.json");
  if (fs.existsSync(collPath)) {
    try {
      const coll = JSON.parse(fs.readFileSync(collPath, "utf8")) as {
        collections?: Record<string, unknown>;
      };
      if (coll.collections) delete coll.collections[DEMO_COLLECTION];
      fs.writeFileSync(collPath, `${JSON.stringify(coll, null, 2)}\n`);
    } catch {
      /* ignore */
    }
  }
  console.log("Removed DEMO knowledge seed.");
  process.exit(0);
}

const { upsertCollection, addPaper } = await import("../server/src/services/library/index.ts");
const { createFact, updateFact } = await import("../server/src/services/library/facts.ts");
const { createKnowledgeItem } = await import("../server/src/services/knowledge/items.ts");
const { createProject, writeProjectConfig, writeFile } = await import(
  "../server/src/services/projectFs.ts"
);

await upsertCollection(DEMO_COLLECTION, "DEMO — not real data");

const paper = await addPaper({
  title: "DEMO fee schedule (synthetic)",
  source: "web",
  url: "https://example.invalid/demo-fee",
  collections: [DEMO_COLLECTION],
  notes: "DEMO — not real data",
});
const dir = path.join(libraryRoot, "papers", paper.citekey);
fs.mkdirSync(dir, { recursive: true });
const text = "The DEMO fee per read is 412.5 USD.";
fs.writeFileSync(path.join(dir, "snapshot.txt"), text);
fs.writeFileSync(
  path.join(dir, "snapshot.json"),
  `${JSON.stringify(
    {
      url: "https://example.invalid/demo-fee",
      fetchedAt: new Date().toISOString(),
      sha256: "demo",
      title: "DEMO fee schedule (synthetic)",
      bytes: text.length,
    },
    null,
    2,
  )}\n`,
);

const fee = await createFact(paper.citekey, {
  type: "value",
  input: "DEMO fee per read",
  answer: "412.5",
  key: "demo-fee-per-read",
  value: 412.5,
  unit: "USD",
  sourceKind: "web",
  highlights: [{ page: 1, start: 0, end: text.length, quote: text }],
});
await updateFact(paper.citekey, fee.id, { status: "confirmed", confirmWithContent: true });

const rejected = await createFact(paper.citekey, {
  type: "value",
  input: "DEMO rejected fee",
  answer: "1",
  key: "demo-rejected-fee",
  value: 1,
  unit: "USD",
  sourceKind: "web",
  highlights: [{ page: 1, start: 0, end: 10, quote: text.slice(0, 10) }],
});
await updateFact(paper.citekey, rejected.id, { status: "rejected" });

const asp = await createKnowledgeItem({
  title: "DEMO US aspirates per year",
  collection: DEMO_COLLECTION,
  knowledgeId: "demo-us-aspirates",
});
await writeFile(
  asp.project.id,
  "main.tex",
  `\\documentclass{article}
\\usepackage{openleaf-knowledge}
\\begin{document}
\\begin{knowledge}[result=count]{DEMO US aspirates per year}
\\begin{assumption}[base]
\\set{base}{100000}
\\end{assumption}
\\begin{calculation}{count}
\\out{base}
\\end{calculation}
\\conclusion{About \\out{count} aspirates per year (DEMO).}
\\end{knowledge}
\\end{document}
`,
);
await writeProjectConfig(asp.project.id, {
  name: "DEMO US aspirates per year",
  kind: "knowledge",
  knowledgeId: "demo-us-aspirates",
  collection: DEMO_COLLECTION,
  mainFile: "main.tex",
});

const market = await createKnowledgeItem({
  title: "DEMO US market size for DeepHeme",
  collection: DEMO_COLLECTION,
  knowledgeId: "demo-us-market-size",
});
await writeFile(
  market.project.id,
  "main.tex",
  `\\documentclass{article}
\\usepackage{openleaf-knowledge}
\\begin{document}
\\begin{knowledge}[result=total]{DEMO US market size for DeepHeme}
\\begin{calculation}{total}
\\fact{demo-fee-per-read} \\times \\kn{demo-us-aspirates}
\\end{calculation}
\\conclusion{Market about \\out{total} (DEMO — not real data).}
\\end{knowledge}
\\end{document}
`,
);
await writeProjectConfig(market.project.id, {
  name: "DEMO US market size for DeepHeme",
  kind: "knowledge",
  knowledgeId: "demo-us-market-size",
  collection: DEMO_COLLECTION,
  mainFile: "main.tex",
});

const paperProj = await createProject("demo-paper-citing-knowledge", "__knowledge_blank__");
await writeFile(
  paperProj.id,
  "main.tex",
  `\\documentclass{article}
\\usepackage{openleaf-knowledge}
\\begin{document}
The DEMO market is \\kn{demo-us-market-size}.
\\end{document}
`,
);
await writeProjectConfig(paperProj.id, {
  name: "DEMO paper citing knowledge",
  kind: "paper",
  collection: DEMO_COLLECTION,
  mainFile: "main.tex",
});

console.log("Seeded DEMO knowledge:", {
  fee: paper.citekey,
  aspirates: asp.project.id,
  market: market.project.id,
  paper: paperProj.id,
});
