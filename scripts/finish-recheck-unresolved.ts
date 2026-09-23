/**
 * Finish leftover work from recheck-unresolved-papers.ts (yona + bib rewrite).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.OPENLEAF_PROJECTS_ROOT ??= path.join(REPO, "projects");
process.env.OPENLEAF_LIBRARY_ROOT ??= path.join(REPO, "library");

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

async function main() {
  const { loadConfig } = await import("../server/src/config.js");
  loadConfig(true);
  const {
    ensureLibraryBoot,
    getPaper,
    updatePaper,
    reindexLibrary,
    closeIndexDb,
    listAllRecords,
  } = await import("../server/src/services/library/index.js");
  const { enrichPaper } = await import("../server/src/services/library/enrich.js");
  const { checkPaperIntegrity, setUnresolvedReason } = await import(
    "../server/src/services/library/integrity.js"
  );
  const { rewriteProjectBibFromLibrary } = await import("../server/src/services/library/cite.js");
  const { derivePaperUrl } = await import("../server/src/services/library/paperUrl.js");

  await ensureLibraryBoot();

  try {
    const paper = await getPaper("yona2021revisiting");
    if (paper.integrity.existence !== "verified") {
      const doi = "10.48550/arXiv.2110.14297";
      await updatePaper("yona2021revisiting", {
        doi,
        arxivId: "2110.14297",
        url: derivePaperUrl({ ...paper, doi, arxivId: "2110.14297" }),
      });
      // Prefer Crossref DOI path over flaky arXiv API.
      const result = await checkPaperIntegrity("yona2021revisiting", { force: true });
      const after = await getPaper("yona2021revisiting");
      console.log("yona integrity:", after.integrity.existence, after.doi, result.detail);
      if (after.integrity.existence !== "verified") {
        const enriched = await enrichPaper("yona2021revisiting", { force: true, checkIntegrity: true });
        console.log("yona enrich:", enriched.paper.integrity.existence, enriched.integrity?.detail);
      }
    } else {
      console.log("yona already verified");
    }
  } catch (err) {
    console.warn("yona failed:", err instanceof Error ? err.message : err);
    try {
      await setUnresolvedReason(
        "yona2021revisiting",
        "arXiv preprint 2110.14297 — temporary lookup failure; identifier attached",
      );
    } catch {
      /* missing */
    }
  }

  // Ensure every unresolved has a reason.
  for (const paper of await listAllRecords()) {
    if (paper.integrity.existence === "verified") continue;
    if (paper.integrity.reason?.trim()) continue;
    await setUnresolvedReason(
      paper.citekey,
      "No Crossref/OpenAlex/arXiv match — review manually or remove if fabricated",
    );
    console.log("filled reason for", paper.citekey);
  }

  const projectsRoot = process.env.OPENLEAF_PROJECTS_ROOT!;
  for (const ent of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    const projectId = ent.name;
    const keys = new Set<string>();
    for (const file of walkTex(path.join(projectsRoot, projectId))) {
      const tex = fs.readFileSync(file, "utf8");
      CITE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CITE_RE.exec(tex))) {
        for (const k of m[1]!.split(",")) if (k.trim()) keys.add(k.trim());
      }
    }
    const bibPath = path.join(projectsRoot, projectId, "references.bib");
    if (fs.existsSync(bibPath)) {
      for (const m of fs.readFileSync(bibPath, "utf8").matchAll(/@\w+\{([^,\s]+)/g)) {
        keys.add(m[1]!);
      }
    }
    const kept: string[] = [];
    for (const k of keys) {
      try {
        await getPaper(k);
        kept.push(k);
      } catch {
        /* dropped */
      }
    }
    if (!kept.length) continue;
    const { count } = await rewriteProjectBibFromLibrary(projectId, kept);
    console.log("BIB", projectId, count);
  }

  await reindexLibrary();
  closeIndexDb();

  const all = await listAllRecords();
  const unresolved = all.filter((p) => p.integrity.existence !== "verified");
  console.log("total", all.length, "unresolved", unresolved.length);
  for (const p of unresolved) console.log("-", p.citekey, ":", p.integrity.reason);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
