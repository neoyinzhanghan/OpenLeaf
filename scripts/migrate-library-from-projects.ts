/**
 * One-shot migration: import every OpenLeaf project's bibliography into the
 * personal citation library, then rewrite each project's references.bib from
 * library records for keys that the project actually cites.
 *
 * Usage (from repo root):
 *   npx tsx scripts/migrate-library-from-projects.ts
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
const PLACEHOLDER_KEYS = new Set(["...", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"]);
const CITEKEY_OK = /^[A-Za-z][A-Za-z0-9_.:-]*$/;

function isUsableCitekey(key: string): boolean {
  return Boolean(key) && CITEKEY_OK.test(key) && !PLACEHOLDER_KEYS.has(key) && !key.includes("\\");
}

function walkTex(dir: string, out: string[] = [], base = dir): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === ".openleaf" || ent.name === ".git" || ent.name === "node_modules") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkTex(full, out, base);
    else if (ent.name.endsWith(".tex") && !SKIP_TEX.has(ent.name)) {
      out.push(path.relative(base, full).replaceAll("\\", "/"));
    }
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
      if (key && isUsableCitekey(key)) keys.add(key);
    }
  }
  return [...keys];
}

function bibitemsToBibtex(tex: string): string {
  const start = tex.indexOf("\\begin{thebibliography}");
  const end = tex.indexOf("\\end{thebibliography}");
  if (start < 0 || end < 0) return "";
  const block = tex.slice(start, end);
  const parts = block.split(/\\bibitem/);
  const entries: string[] = [];
  for (const part of parts.slice(1)) {
    const keyMatch = part.match(/^(?:\[[^\]]*\])?\{([^}]+)\}/);
    if (!keyMatch) continue;
    const citekey = keyMatch[1]!.trim();
    if (!isUsableCitekey(citekey)) continue;
    let body = part.slice(keyMatch[0].length);
    body = body
      .replace(/\\newblock/g, " ")
      .replace(/\\emph\{([^}]*)\}/g, "$1")
      .replace(/\\textit\{([^}]*)\}/g, "$1")
      .replace(/\\textsc\{([^}]*)\}/g, "$1")
      .replace(/\\protect\\citeauthoryear\{[^}]*\}\{[^}]*\}/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const yearMatch = body.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? Number(yearMatch[0]) : null;
    let title = body;
    const italicHint = body.match(
      /\.\s+([A-Z][^.]+)\.\s+(?:In |Springer|Wiley|Cambridge|Academic|SIAM|Neural|Econometrica|Journal)/,
    );
    if (italicHint) title = italicHint[1]!.trim();
    else {
      const bits = body.split(/\.\s+/);
      title = (bits[1] ?? bits[0] ?? citekey).replace(/^In\s+/i, "").slice(0, 200);
    }
    const authorBit = body.split(/\.\s+/)[0] ?? "Unknown";
    const authors = authorBit
      .split(/\s+and\s+|,\s+(?=[A-Z])/)
      .map((a) => a.replace(/~/g, " ").replace(/\s+/g, " ").trim())
      .filter((a) => a && !/^\d+$/.test(a))
      .slice(0, 8)
      .map((name) => {
        const parts = name.split(/\s+/);
        if (parts.length === 1) return { given: "", family: parts[0]! };
        return { given: parts.slice(0, -1).join(" "), family: parts[parts.length - 1]! };
      });

    const fields = [
      `  title = {${title.replace(/[{}]/g, "")}}`,
      `  author = {${authors.map((a) => (a.given ? `${a.family}, ${a.given}` : a.family)).join(" and ")}}`,
    ];
    if (year) fields.push(`  year = {${year}}`);
    entries.push(`@misc{${citekey},\n${fields.join(",\n")}\n}\n`);
  }
  return entries.join("\n");
}

function projectDirs(projectsRoot: string): string[] {
  return fs
    .readdirSync(projectsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name);
}

async function main() {
  const { loadConfig } = await import("../server/src/config.js");
  loadConfig(true);

  const { importBibtex } = await import("../server/src/services/library/import.js");
  const {
    addPaper,
    getPaper,
    listAllRecords,
    reindexLibrary,
    closeIndexDb,
    ensureLibraryBoot,
  } = await import("../server/src/services/library/index.js");
  const { rewriteProjectBibFromLibrary } = await import("../server/src/services/library/cite.js");
  const { scanProjectCitations } = await import("../server/src/services/library/citations.js");

  await ensureLibraryBoot();
  const projectsRoot = process.env.OPENLEAF_PROJECTS_ROOT!;
  const summary: Record<string, unknown> = {};

  let importedTotal = 0;
  let skippedTotal = 0;

  async function ensureStub(citekey: string): Promise<void> {
    try {
      await getPaper(citekey);
    } catch {
      await addPaper({
        citekey,
        title: citekey,
        source: "manual",
        authors: [],
        notes: "Imported as stub from project \\cite{}; enrich via Library lookup.",
      });
    }
  }

  for (const id of projectDirs(projectsRoot)) {
    const proj = path.join(projectsRoot, id);
    const bibPaths: string[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === ".openleaf" || ent.name === ".git") continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name.endsWith(".bib")) bibPaths.push(full);
      }
    };
    walk(proj);
    for (const bib of bibPaths) {
      const text = fs.readFileSync(bib, "utf8");
      if (!text.trim() || text.trim() === "% bibliography\n") continue;
      const result = await importBibtex(text);
      importedTotal += result.imported.length;
      skippedTotal += result.skipped.length;
      console.log(
        `[bib] ${id}/${path.relative(proj, bib)}: +${result.imported.length} skip ${result.skipped.length} err ${result.errors.length}`,
      );
      if (result.errors.length) console.log("  errors", result.errors.slice(0, 5));
    }
  }

  for (const id of ["Tj_label_shift_notes", "Label-free_correction_for_label_shift"]) {
    const mainPath = path.join(projectsRoot, id, "main.tex");
    if (!fs.existsSync(mainPath)) continue;
    const tex = fs.readFileSync(mainPath, "utf8");
    const bibtex = bibitemsToBibtex(tex);
    if (!bibtex.trim()) continue;
    const result = await importBibtex(bibtex);
    importedTotal += result.imported.length;
    skippedTotal += result.skipped.length;
    console.log(`[thebibliography] ${id}: +${result.imported.length} skip ${result.skipped.length}`);
    const bibFile = path.join(projectsRoot, id, "references.bib");
    if (!fs.existsSync(bibFile) || fs.statSync(bibFile).size < 40) {
      fs.writeFileSync(bibFile, `% Migrated from thebibliography → OpenLeaf library\n\n${bibtex}`);
    }
  }

  for (const id of projectDirs(projectsRoot)) {
    const proj = path.join(projectsRoot, id);
    const texFiles = walkTex(proj);
    const citeKeys = new Set<string>();
    for (const rel of texFiles) {
      const tex = fs.readFileSync(path.join(proj, rel), "utf8");
      for (const k of extractCites(tex)) citeKeys.add(k);
    }

    // Also import any keys still only present in the project .bib (uncited but local).
    const bibFile = path.join(proj, "references.bib");
    if (fs.existsSync(bibFile)) {
      const bibText = fs.readFileSync(bibFile, "utf8");
      if (bibText.trim() && !bibText.includes("OpenLeaf library-synced")) {
        const result = await importBibtex(bibText);
        importedTotal += result.imported.length;
        skippedTotal += result.skipped.length;
      }
    }

    const synced: string[] = [];
    const stubs: string[] = [];
    const missing: string[] = [];
    const usable = [...citeKeys].filter(isUsableCitekey).sort();
    for (const key of usable) {
      try {
        await getPaper(key);
      } catch {
        await ensureStub(key);
        stubs.push(key);
      }
    }
    try {
      if (usable.length > 0 || fs.existsSync(bibFile)) {
        const { count } = await rewriteProjectBibFromLibrary(id, usable);
        synced.push(...usable.slice(0, count));
      }
    } catch (err) {
      missing.push(err instanceof Error ? err.message : String(err));
    }

    const mainPath = path.join(proj, "main.tex");
    if (fs.existsSync(mainPath)) {
      let main = fs.readFileSync(mainPath, "utf8");
      if (main.includes("\\begin{thebibliography}")) {
        const endBib = main.indexOf("\\end{thebibliography}");
        if (endBib >= 0) {
          const after = main.slice(endBib + "\\end{thebibliography}".length);
          if (/\\documentclass/.test(after)) {
            main = main.slice(0, endBib + "\\end{thebibliography}".length) + "\n";
          }
        }
        const hasBibStyle = /\\bibliographystyle\{/.test(main);
        const hasBibCmd = /\\bibliography\{references\}/.test(main);
        const replacement =
          (hasBibStyle ? "" : "\\bibliographystyle{plainnat}\n") +
          (hasBibCmd ? "" : "\\bibliography{references}\n");
        main = main.replace(
          /\\begin\{thebibliography\}[\s\S]*?\\end\{thebibliography\}/,
          `${replacement.trim()}\n`,
        );
        fs.writeFileSync(mainPath, main);
        console.log(`[wire] ${id}/main.tex → \\bibliography{references}`);
      }
    }

    const scanFiles = texFiles.filter((f) => !f.startsWith("misc/"));
    let instances = 0;
    try {
      const scanned = await scanProjectCitations(id, scanFiles);
      instances = scanned.length;
    } catch (err) {
      console.warn(`[scan] ${id}`, err);
    }

    summary[id] = {
      citeKeys: citeKeys.size,
      synced: synced.length,
      stubs: stubs.length,
      instances,
      missing: missing.slice(0, 10),
    };
    console.log(
      `[project] ${id}: keys=${citeKeys.size} synced=${synced.length} stubs=${stubs.length} citations.json=${instances}`,
    );
  }

  await reindexLibrary();
  const all = await listAllRecords();
  console.log(`\nLibrary now has ${all.length} papers (imported≈${importedTotal}, skipped-dup≈${skippedTotal})`);
  console.log(JSON.stringify(summary, null, 2));
  closeIndexDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
