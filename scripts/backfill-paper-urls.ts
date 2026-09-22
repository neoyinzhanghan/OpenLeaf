/**
 * Ensure every library paper has a public url (doi.org / arxiv / publisher / Scholar).
 *
 *   npx tsx scripts/backfill-paper-urls.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.OPENLEAF_PROJECTS_ROOT ??= path.join(REPO, "projects");
process.env.OPENLEAF_LIBRARY_ROOT ??= path.join(REPO, "library");

const KNOWN_URLS: Record<string, string> = {
  precipio2018hemepath:
    "https://www.precipiodx.com/precipio-and-nucleai-partner-to-develop-artificial-intelligence-powered-hemepath-solution/",
  healthprices2023bone: "https://www.healthprices.org/diagnostic-bone-marrow-biopsy/national",
  lls_bloodcancer_stats: "https://www.lls.org/facts-and-statistics/facts-and-statistics-overview",
  msk2025deepheme_news: "https://www.mskcc.org/",
  openleaf2026: "https://github.com/neoyinzhanghan/OpenLeaf",
};

async function main() {
  const { loadConfig } = await import("../server/src/config.js");
  loadConfig(true);
  const {
    ensureLibraryBoot,
    listAllRecords,
    updatePaper,
    getPaper,
    closeIndexDb,
    reindexLibrary,
  } = await import("../server/src/services/library/index.js");
  const { derivePaperUrl, doiUrl } = await import("../server/src/services/library/paperUrl.js");
  const { lookupExternal } = await import("../server/src/services/library/import.js");
  const { rewriteProjectBibFromLibrary } = await import("../server/src/services/library/cite.js");

  await ensureLibraryBoot();
  const all = await listAllRecords();
  let updated = 0;
  let lookedUp = 0;

  for (let i = 0; i < all.length; i++) {
    const paper = all[i]!;
    let url = KNOWN_URLS[paper.citekey] ?? paper.url;
    let doi = paper.doi;
    let arxivId = paper.arxivId;

    // Alias: copy DOI landing from peer without storing conflicting DOI.
    const alias = (paper.notes || "").match(/alias of (\S+)/i);
    if ((!url || !doi) && alias) {
      try {
        const peer = await getPaper(alias[1]!.replace(/;.*$/, ""));
        if (peer.doi) url = doiUrl(peer.doi);
        else if (peer.url) url = peer.url;
      } catch {
        /* ignore */
      }
    }

    if ((!doi && !arxivId && !url) || (url && !/^https?:\/\//i.test(url))) {
      try {
        const resolved = await lookupExternal({ title: paper.title });
        if (resolved) {
          lookedUp++;
          if (resolved.doi && !doi) {
            // Only set DOI if free; else keep URL only.
            try {
              await updatePaper(paper.citekey, { doi: resolved.doi });
              doi = resolved.doi;
            } catch {
              url = resolved.url || (resolved.doi ? doiUrl(resolved.doi) : url);
            }
          }
          if (resolved.url) url = resolved.url;
          if (resolved.arxivId && !arxivId) arxivId = resolved.arxivId;
        }
      } catch {
        /* soft fail */
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    const nextUrl = derivePaperUrl({
      url: url ?? null,
      doi,
      arxivId,
      title: paper.title,
    });

    if (paper.url !== nextUrl || paper.arxivId !== arxivId) {
      await updatePaper(paper.citekey, {
        url: nextUrl,
        ...(arxivId && arxivId !== paper.arxivId ? { arxivId } : {}),
      });
      updated++;
    }

    if ((i + 1) % 25 === 0 || i + 1 === all.length) {
      console.log(`[${i + 1}/${all.length}] updated=${updated} lookedUp=${lookedUp}`);
    }
  }

  // Rewrite project bibs so url fields sync
  const projectsRoot = process.env.OPENLEAF_PROJECTS_ROOT!;
  const citeRe =
    /\\(?:cite|citep|nocite|citet)\*?\{([^}]+)\}/g;
  for (const ent of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    const keys = new Set<string>();
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".") || e.name === "aoas-sample.tex" || e.name === "aoas-template.tex") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".tex")) {
          const tex = fs.readFileSync(full, "utf8");
          let m: RegExpExecArray | null;
          citeRe.lastIndex = 0;
          while ((m = citeRe.exec(tex))) {
            for (const k of m[1]!.split(",")) {
              const key = k.trim();
              if (/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(key)) keys.add(key);
            }
          }
        }
      }
    };
    walk(path.join(projectsRoot, ent.name));
    if (!keys.size) continue;
    const usable: string[] = [];
    for (const k of [...keys].sort()) {
      try {
        await getPaper(k);
        usable.push(k);
      } catch {
        /* skip */
      }
    }
    if (usable.length) {
      await rewriteProjectBibFromLibrary(ent.name, usable);
      console.log(`[bib] ${ent.name}: ${usable.length} urls synced`);
    }
  }

  await reindexLibrary();
  const final = await listAllRecords();
  const missing = final.filter((p) => !p.url || !/^https?:\/\//i.test(p.url));
  console.log(
    JSON.stringify(
      {
        total: final.length,
        withUrl: final.length - missing.length,
        missing: missing.map((p) => p.citekey),
        sample: final.slice(0, 3).map((p) => ({ citekey: p.citekey, url: p.url })),
      },
      null,
      2,
    ),
  );
  closeIndexDb();
  if (missing.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
