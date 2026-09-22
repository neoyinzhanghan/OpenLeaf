/**
 * Sync a library record into a project's references.bib (generated view).
 * Library record.json is canonical — do not let the two drift.
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { getPaper } from "./index.js";
import type { PaperRecord } from "./types.js";
import { projectDir, readFile, writeFile } from "../projectFs.js";

function escapeBibtex(value: string): string {
  return value
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/[{}]/g, (c) => `\\${c}`)
    .replace(/\s+/g, " ")
    .trim();
}

function formatAuthors(authors: PaperRecord["authors"]): string {
  if (authors.length === 0) return "Unknown";
  return authors
    .map((a) => {
      const given = a.given.trim();
      return given ? `${a.family}, ${given}` : a.family;
    })
    .join(" and ");
}

export function paperToBibtex(paper: PaperRecord): string {
  const fields: string[] = [];
  fields.push(`  title = {${escapeBibtex(paper.title)}}`);
  fields.push(`  author = {${escapeBibtex(formatAuthors(paper.authors))}}`);
  if (paper.year != null) fields.push(`  year = {${paper.year}}`);
  if (paper.venue) fields.push(`  journal = {${escapeBibtex(paper.venue)}}`);
  if (paper.doi) fields.push(`  doi = {${escapeBibtex(paper.doi)}}`);
  if (paper.arxivId) {
    fields.push(`  eprint = {${escapeBibtex(paper.arxivId)}}`);
    fields.push(`  archivePrefix = {arXiv}`);
  }
  if (paper.abstract) fields.push(`  abstract = {${escapeBibtex(paper.abstract.slice(0, 2000))}}`);
  const type = paper.arxivId && !paper.doi ? "misc" : "article";
  return `@${type}{${paper.citekey},\n${fields.join(",\n")}\n}\n`;
}

function findBibFile(projectId: string): string {
  const root = projectDir(projectId);
  const candidates = ["references.bib", "refs.bib", "bibliography.bib", "main.bib"];
  for (const c of candidates) {
    if (fs.existsSync(path.join(root, c))) return c;
  }
  return "references.bib";
}

/** Upsert a single @entry for citekey in the project's .bib file. */
export async function syncCitekeyToBib(projectId: string, citekey: string): Promise<{ bibFile: string }> {
  const paper = await getPaper(citekey);
  const bibFile = findBibFile(projectId);
  let existing = "";
  try {
    const payload = await readFile(projectId, bibFile);
    if (payload.encoding === "utf8") existing = payload.content;
  } catch {
    existing = "% bibliography — generated from OpenLeaf library\n";
  }

  const entry = paperToBibtex(paper);
  const entryRe = new RegExp(`@[a-zA-Z]+\\{${citekey}\\s*,[\\s\\S]*?\\n\\}`, "m");
  let next: string;
  if (entryRe.test(existing)) {
    next = existing.replace(entryRe, entry.trimEnd());
  } else {
    next = `${existing.replace(/\s*$/, "")}\n\n${entry}`;
  }
  await writeFile(projectId, bibFile, next);
  return { bibFile };
}

/**
 * Ensure citekey is in the project's .bib. Optionally insert \\cite{citekey}
 * at file:line (column end of line by default).
 */
export async function citeIntoProject(
  projectId: string,
  opts: { citekey: string; file?: string; line?: number },
): Promise<{ bibFile: string; inserted: boolean }> {
  const { bibFile } = await syncCitekeyToBib(projectId, opts.citekey);
  let inserted = false;
  if (opts.file && opts.line && opts.line > 0) {
    const payload = await readFile(projectId, opts.file);
    if (payload.encoding !== "utf8" || !payload.text) {
      throw Object.assign(new Error("Cannot cite into a binary file"), { status: 400 });
    }
    const lines = payload.content.split("\n");
    const idx = opts.line - 1;
    if (idx < 0 || idx >= lines.length) {
      throw Object.assign(new Error("Line out of range"), { status: 400 });
    }
    const cite = `\\cite{${opts.citekey}}`;
    if (!lines[idx]!.includes(cite)) {
      lines[idx] = `${lines[idx]}${lines[idx]!.endsWith(" ") ? "" : " "}${cite}`;
      await writeFile(projectId, opts.file, lines.join("\n"));
      inserted = true;
    }
  }
  return { bibFile, inserted };
}
