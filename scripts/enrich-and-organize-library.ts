/**
 * Organize the citation library by OpenLeaf project, enrich every paper from
 * Crossref/OpenAlex/arXiv, then force integrity checks.
 *
 * Usage (from repo root; stop openleaf.service first if it holds the DB):
 *   npx tsx scripts/enrich-and-organize-library.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.OPENLEAF_PROJECTS_ROOT ??= path.join(REPO, "projects");
process.env.OPENLEAF_LIBRARY_ROOT ??= path.join(REPO, "library");

const CITE_RE =
  /\\(?:cite|citep|nocite|citet|citepauthor|citeyear|citeyearpar|parencite|autocite|textcite|footcite|fullcite|citeauthor)\*?\{([^}]+)\}/g;
const SKIP_TEX = new Set(["aoas-sample.tex", "aoas-template.tex"]);
const CITEKEY_OK = /^[A-Za-z][A-Za-z0-9_.:-]*$/;

const PROJECT_NAMES: Record<string, string> = {
  DeepHeme_CompBio_Retreat_Talk: "DeepHeme CompBio Retreat",
  Inference_Powered_Prediction: "Inference Powered Prediction",
  "Label-free_correction_for_label_shift": "Label-free Correction",
  PBS_thumbnail_specimen_clf: "PBS Thumbnail Classifier",
  Tj_label_shift_notes: "Tj Label Shift Notes",
  USCAP2027_DeepHeme_Monitoring: "USCAP 2027 DeepHeme Monitoring",
  "deepheme-msk-natmed": "DeepHeme MSK NatMed",
  "example-article": "Example Article",
  test_project: "Test Project",
};

function friendlyName(projectId: string): string {
  return PROJECT_NAMES[projectId] ?? projectId.replaceAll("_", " ");
}

function walkTex(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === ".openleaf" || ent.name === ".git" || ent.name === "node_modules") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkTex(full, out);
    else if (ent.name.endsWith(".tex") && !SKIP_TEX.has(ent.name)) out.push(full);
  }
  return out;
}

function extractCites(tex: string): string[] {
  const keys = new Set<string>();
  CITE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITE_RE.exec(tex))) {
    for (const k of m[1]!.split(",")) {
      const key = k.trim();
      if (key && CITEKEY_OK.test(key) && !/^r\d+$/.test(key) && key !== "..." && key !== "???") {
        keys.add(key);
      }
    }
  }
  return [...keys];
}

async function main() {
  const { loadConfig } = await import("../server/src/config.js");
  loadConfig(true);

  const {
    ensureLibraryBoot,
    getPaper,
    listAllRecords,
    reindexLibrary,
    closeIndexDb,
    upsertCollection,
    updatePaper,
  } = await import("../server/src/services/library/index.js");
  const { enrichLibrary } = await import("../server/src/services/library/enrich.js");
  const { rewriteProjectBibFromLibrary } = await import("../server/src/services/library/cite.js");

  await ensureLibraryBoot();
  const projectsRoot = process.env.OPENLEAF_PROJECTS_ROOT!;

  // --- Project collections -------------------------------------------------
  const projectCiteMap = new Map<string, Set<string>>();
  const paperProjects = new Map<string, Set<string>>();

  for (const ent of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    const id = ent.name;
    const cites = new Set<string>();
    for (const texPath of walkTex(path.join(projectsRoot, id))) {
      for (const key of extractCites(fs.readFileSync(texPath, "utf8"))) cites.add(key);
    }
    projectCiteMap.set(id, cites);
    await upsertCollection(id, friendlyName(id));
    console.log(`[collection] ${id} (${friendlyName(id)}): ${cites.size} cited keys`);
    for (const key of cites) {
      if (!paperProjects.has(key)) paperProjects.set(key, new Set());
      paperProjects.get(key)!.add(id);
    }
  }

  await upsertCollection("unassigned", "Unassigned");

  const all = await listAllRecords();
  let assigned = 0;
  for (const paper of all) {
    const projects = paperProjects.get(paper.citekey);
    const nextCollections = projects?.size
      ? [...projects].sort()
      : paper.collections.filter((c) => c !== "unassigned").length
        ? paper.collections
        : ["unassigned"];
    const same =
      nextCollections.length === paper.collections.length &&
      nextCollections.every((c) => paper.collections.includes(c));
    if (!same) {
      await updatePaper(paper.citekey, { collections: nextCollections });
      assigned++;
    }
  }
  console.log(`[collections] updated membership on ${assigned} papers`);

  // --- Enrich from internet + integrity check ------------------------------
  console.log(`[enrich] starting live lookup for ${all.length} papers…`);
  const results = await enrichLibrary({
    force: true,
    checkIntegrity: true,
    delayMs: 220,
    onProgress: (done, total, result) => {
      if (done % 10 === 0 || done === total || result.enriched) {
        const mark = result.enriched ? "enriched" : result.reason ?? "skip";
        console.log(`  [${done}/${total}] ${result.citekey}: ${mark} · ${result.paper.integrity.existence}`);
      }
    },
  });

  const enriched = results.filter((r) => r.enriched).length;
  const verified = results.filter((r) => r.paper.integrity.existence === "verified").length;
  const unresolved = results.filter((r) => r.paper.integrity.existence === "unresolved").length;
  const mismatch = results.filter((r) => r.paper.integrity.existence === "mismatch").length;
  console.log(
    `[enrich] done: enriched=${enriched} verified=${verified} unresolved=${unresolved} mismatch=${mismatch}`,
  );

  // --- Rewrite project .bibs from enriched library records -----------------
  for (const [id, cites] of projectCiteMap) {
    if (!cites.size) continue;
    const usable: string[] = [];
    for (const key of [...cites].sort()) {
      try {
        await getPaper(key);
        usable.push(key);
      } catch {
        /* missing from library */
      }
    }
    if (!usable.length) continue;
    const { count } = await rewriteProjectBibFromLibrary(id, usable);
    console.log(`[bib] ${id}: rewrote ${count} entries from library`);
  }

  await reindexLibrary();
  const final = await listAllRecords();
  const withAuthors = final.filter((p) => p.authors.length > 0).length;
  console.log(
    JSON.stringify(
      {
        papers: final.length,
        withAuthors,
        verified: final.filter((p) => p.integrity.existence === "verified").length,
        unresolved: final.filter((p) => p.integrity.existence === "unresolved").length,
        collections: Object.fromEntries(
          [...projectCiteMap.entries()].map(([id, cites]) => [id, cites.size]),
        ),
      },
      null,
      2,
    ),
  );
  closeIndexDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
