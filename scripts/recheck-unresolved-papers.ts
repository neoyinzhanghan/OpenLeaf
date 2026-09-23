/**
 * Recheck unresolved library papers online.
 * - Attach known DOIs / arXiv ids and re-run integrity → verified when possible
 * - Keep real non-journal sources with an explicit integrity.reason
 * - Delete hallucinated / unfindable records and scrub project bibliographies
 *
 * Usage (from repo root):
 *   npx tsx scripts/recheck-unresolved-papers.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.OPENLEAF_PROJECTS_ROOT ??= path.join(REPO, "projects");
process.env.OPENLEAF_LIBRARY_ROOT ??= path.join(REPO, "library");

/** Papers that Crossref/arXiv can verify once identifiers are attached. */
const VERIFY_IDS: Record<string, { doi?: string; arxivId?: string }> = {
  Michelot86: { doi: "10.1007/BF00938486" },
  Stewart77: { doi: "10.1137/1019104" },
  White84: { doi: "10.1016/C2009-0-21869-1" },
  vdV98: { doi: "10.1017/CBO9780511802256" },
  hamori2018ensemble: { doi: "10.3390/jrfm11010012" },
  wang2020comprehensive: { doi: "10.1007/s40745-020-00253-5" },
  zhang2019medical: { doi: "10.1016/j.media.2019.02.010" },
  yona2021revisiting: { arxivId: "2110.14297" },
};

/**
 * Real sources that are not indexed as Crossref journal articles.
 * These stay in the library with an explicit reason (not "verified").
 */
const KEEP_WITH_REASON: Record<string, string> = {
  elo1978rating:
    "Book (Arco Publishing, 1978) — not indexed as a Crossref journal article",
  foucar: "Textbook (Bone Marrow Pathology) — print monograph, not a journal article",
  kaushansky_williams_2021:
    "Textbook (Williams Hematology, 10th ed., McGraw Hill) — not a journal article",
  swerdlow_who_2017:
    "WHO / IARC blue-book monograph (Revised 4th edition) — not a journal article",
  goldgof2022hemelabel:
    "USCAP 2022 conference abstract (bundled in Modern Pathology abstracts; not a full paper)",
  healthprices2023bone:
    "Non-scholarly healthcare pricing webpage (healthprices.org)",
  lls_bloodcancer_stats:
    "Leukemia & Lymphoma Society public fact sheet — organization statistics page",
  msk2025deepheme_news:
    "Institutional news / press page (MSK) — not a peer-reviewed article",
  precipio2018hemepath:
    "Company press release (Precipio / Nucleai partnership) — not peer-reviewed",
  openleaf2026:
    "Unpublished software / demo citation for OpenLeaf itself — not an external publication",
};

/** Exact title not found in Crossref/OpenAlex — treat as hallucinated. */
const REMOVE_HALLUCINATED = [
  "barcellini2015clinical",
  "porwit2011classification",
  "verma2013evaluation",
];

const CITE_RE =
  /\\(?:cite|citep|nocite|citet|citepauthor|citeyear|citeyearpar|parencite|autocite|textcite|footcite|fullcite|citeauthor)\*?\{([^}]+)\}/g;

function walkTex(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === ".openleaf" || ent.name === ".git" || ent.name === "node_modules") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkTex(full, out);
    else if (ent.name.endsWith(".tex")) out.push(full);
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
      if (key) keys.add(key);
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
    updatePaper,
    deletePaper,
    reindexLibrary,
    closeIndexDb,
  } = await import("../server/src/services/library/index.js");
  const { enrichPaper } = await import("../server/src/services/library/enrich.js");
  const { checkPaperIntegrity } = await import("../server/src/services/library/integrity.js");
  const { rewriteProjectBibFromLibrary } = await import("../server/src/services/library/cite.js");
  const { derivePaperUrl } = await import("../server/src/services/library/paperUrl.js");

  await ensureLibraryBoot();

  const all = await listAllRecords();
  const unresolved = all.filter((p) => p.integrity.existence !== "verified");
  console.log(`Unresolved before: ${unresolved.length}`);

  const verified: string[] = [];
  const reasoned: string[] = [];
  const removed: string[] = [];
  const stillBad: string[] = [];

  // 1) Attach identifiers + enrich/check for papers we can verify online.
  for (const [citekey, ids] of Object.entries(VERIFY_IDS)) {
    try {
      const paper = await getPaper(citekey);
      if (paper.integrity.existence === "verified" && paper.doi) {
        console.log(`VERIFY skip ${citekey}: already verified`);
        verified.push(citekey);
        continue;
      }
      const doi = ids.doi ?? paper.doi;
      const arxivId = ids.arxivId ?? paper.arxivId;
      // Prefer Crossref-style arXiv DOI when we only have an arXiv id (avoids flaky arXiv API).
      const arxivDoi =
        !doi && arxivId ? `10.48550/arXiv.${arxivId.replace(/^arxiv:/i, "")}` : null;
      await updatePaper(citekey, {
        doi: doi ?? arxivDoi ?? null,
        arxivId: arxivId ?? null,
        url: derivePaperUrl({
          ...paper,
          doi: doi ?? arxivDoi ?? null,
          arxivId: arxivId ?? null,
        }),
      });
      const enriched = await enrichPaper(citekey, { force: true, checkIntegrity: true });
      const after = enriched.paper;
      console.log(
        `VERIFY ${citekey}: existence=${after.integrity.existence}` +
          (after.doi ? ` doi=${after.doi}` : "") +
          (after.arxivId ? ` arxiv=${after.arxivId}` : "") +
          (enriched.integrity?.detail ? ` (${enriched.integrity.detail})` : ""),
      );
      if (after.integrity.existence === "verified") verified.push(citekey);
      else stillBad.push(citekey);
    } catch (err) {
      console.warn(`VERIFY failed ${citekey}:`, err instanceof Error ? err.message : err);
      stillBad.push(citekey);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // 2) Keep real non-journal sources with explicit reasons.
  const { setUnresolvedReason } = await import("../server/src/services/library/integrity.js");
  for (const [citekey, reason] of Object.entries(KEEP_WITH_REASON)) {
    try {
      await getPaper(citekey);
      await checkPaperIntegrity(citekey, { force: true });
      const refreshed = await getPaper(citekey);
      if (refreshed.integrity.existence === "verified") {
        console.log(`KEEP ${citekey}: unexpectedly verified — leaving as verified`);
        verified.push(citekey);
        continue;
      }
      await setUnresolvedReason(citekey, reason);
      console.log(`REASON ${citekey}: ${reason}`);
      reasoned.push(citekey);
    } catch (err) {
      console.warn(`REASON failed ${citekey}:`, err instanceof Error ? err.message : err);
      stillBad.push(citekey);
    }
  }

  // 3) Remove hallucinated / unfindable titles.
  for (const citekey of REMOVE_HALLUCINATED) {
    try {
      await getPaper(citekey);
      await deletePaper(citekey);
      console.log(`REMOVE ${citekey}: no matching Crossref/OpenAlex source for this title`);
      removed.push(citekey);
    } catch (err) {
      console.warn(`REMOVE skip ${citekey}:`, err instanceof Error ? err.message : err);
    }
  }

  // 4) Any leftover unresolved without a reason — recheck and demand a reason.
  const { setUnresolvedReason: setReason } = await import("../server/src/services/library/integrity.js");
  const afterAll = await listAllRecords();
  for (const paper of afterAll) {
    if (paper.integrity.existence === "verified") continue;
    if (paper.integrity.reason?.trim()) continue;
    try {
      const result = await checkPaperIntegrity(paper.citekey, { force: true });
      const again = await getPaper(paper.citekey);
      if (again.integrity.existence === "verified") {
        verified.push(paper.citekey);
        continue;
      }
      const reason =
        result.detail?.trim() ||
        "No Crossref/OpenAlex/arXiv match — review manually or remove if fabricated";
      await setReason(paper.citekey, reason);
      console.log(`FALLBACK REASON ${paper.citekey}: ${reason}`);
      reasoned.push(paper.citekey);
    } catch (err) {
      const reason = `Online check failed (${err instanceof Error ? err.message : String(err)}); no verified source attached yet`;
      await setReason(paper.citekey, reason);
      console.warn(`FALLBACK REASON ${paper.citekey}: ${reason}`);
      reasoned.push(paper.citekey);
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  // 5) Rebuild project bibliographies from remaining library cites (drops removed keys).
  const projectsRoot = process.env.OPENLEAF_PROJECTS_ROOT!;
  for (const ent of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    const projectId = ent.name;
    const texFiles = walkTex(path.join(projectsRoot, projectId));
    const keys = new Set<string>();
    for (const file of texFiles) {
      for (const k of extractCites(fs.readFileSync(file, "utf8"))) keys.add(k);
    }
    // Also keep keys already in references.bib that still exist in library.
    const bibPath = path.join(projectsRoot, projectId, "references.bib");
    if (fs.existsSync(bibPath)) {
      const bib = fs.readFileSync(bibPath, "utf8");
      for (const m of bib.matchAll(/@\w+\{([^,\s]+)/g)) keys.add(m[1]!);
    }
    const kept: string[] = [];
    for (const k of keys) {
      try {
        await getPaper(k);
        kept.push(k);
      } catch {
        /* dropped from library */
      }
    }
    if (!kept.length) continue;
    try {
      const { count } = await rewriteProjectBibFromLibrary(projectId, kept);
      console.log(`BIB ${projectId}: ${count} entries (scrubbed removed keys)`);
    } catch (err) {
      console.warn(`BIB ${projectId} failed:`, err instanceof Error ? err.message : err);
    }
  }

  await reindexLibrary();
  closeIndexDb();

  const final = await listAllRecords();
  const unresolvedFinal = final.filter((p) => p.integrity.existence !== "verified");
  console.log("\n=== Summary ===");
  console.log(`Verified this run: ${[...new Set(verified)].length}`);
  console.log(`Kept with reason: ${[...new Set(reasoned)].length}`);
  console.log(`Removed hallucinated: ${removed.length} → ${removed.join(", ") || "(none)"}`);
  console.log(`Library size: ${final.length}`);
  console.log(`Still unresolved: ${unresolvedFinal.length}`);
  for (const p of unresolvedFinal) {
    console.log(`  - ${p.citekey}: ${p.integrity.reason ?? "(no reason)"}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
