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
  if (paper.url) fields.push(`  url = {${escapeBibtex(paper.url)}}`);
  else if (paper.doi) fields.push(`  url = {https://doi.org/${escapeBibtex(paper.doi)}}`);
  if (paper.arxivId) {
    fields.push(`  eprint = {${escapeBibtex(paper.arxivId)}}`);
    fields.push(`  archivePrefix = {arXiv}`);
  }
  if (paper.abstract) fields.push(`  abstract = {${escapeBibtex(paper.abstract.slice(0, 2000))}}`);
  const type = paper.arxivId && !paper.doi ? "misc" : "article";
  return `@${type}{${paper.citekey},\n${fields.join(",\n")}\n}\n`;
}

function risLine(tag: string, value: string): string {
  const cleaned = value.replace(/\r?\n/g, " ").trim();
  return cleaned ? `${tag}  - ${cleaned}\n` : "";
}

/** RIS (Research Information Systems) export for a single paper. */
export function paperToRis(paper: PaperRecord): string {
  const type = paper.arxivId && !paper.doi ? "THES" : "JOUR";
  let out = risLine("TY", type);
  out += risLine("ID", paper.citekey);
  out += risLine("TI", paper.title);
  for (const a of paper.authors) {
    const name = a.given.trim() ? `${a.family}, ${a.given}` : a.family;
    out += risLine("AU", name);
  }
  if (paper.year != null) out += risLine("PY", String(paper.year));
  if (paper.venue) out += risLine("JO", paper.venue);
  if (paper.doi) out += risLine("DO", paper.doi);
  if (paper.url) out += risLine("UR", paper.url);
  else if (paper.doi) out += risLine("UR", `https://doi.org/${paper.doi}`);
  if (paper.arxivId) out += risLine("UR", `https://arxiv.org/abs/${paper.arxivId}`);
  if (paper.abstract) out += risLine("AB", paper.abstract.slice(0, 4000));
  for (const tag of paper.tags) out += risLine("KW", tag);
  out += "ER  - \n";
  return out;
}

export type LibraryExportFormat = "bibtex" | "ris";

export async function exportLibraryPapers(opts: {
  citekeys?: string[];
  collection?: string;
  format: LibraryExportFormat;
}): Promise<{ text: string; count: number; filename: string; format: LibraryExportFormat }> {
  const { searchPapers, getPaper } = await import("./index.js");
  let papers: PaperRecord[];
  if (opts.citekeys?.length) {
    const unique = [...new Set(opts.citekeys.map((k) => k.trim()).filter(Boolean))];
    papers = [];
    for (const key of unique) {
      papers.push(await getPaper(key));
    }
  } else if (opts.collection?.trim()) {
    papers = await searchPapers({ collection: opts.collection.trim(), limit: 2000 });
  } else {
    throw Object.assign(new Error("Provide citekeys or collection"), { status: 400 });
  }
  if (!papers.length) {
    throw Object.assign(new Error("No papers to export"), { status: 404 });
  }

  const format = opts.format;
  const text =
    format === "ris"
      ? papers.map((p) => paperToRis(p)).join("\n")
      : papers.map((p) => paperToBibtex(p).trimEnd()).join("\n\n") + "\n";

  const stamp = new Date().toISOString().slice(0, 10);
  const base =
    opts.collection?.trim()
      ? `openleaf-${opts.collection.trim()}`
      : papers.length === 1
        ? papers[0]!.citekey
        : `openleaf-export-${papers.length}`;
  const ext = format === "ris" ? "ris" : "bib";
  return { text, count: papers.length, filename: `${base}-${stamp}.${ext}`, format };
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
 * Rewrite the project's bibliography from library records for the given citekeys only.
 * Library remains canonical; the .bib is a generated view of cited keys.
 */
export async function rewriteProjectBibFromLibrary(
  projectId: string,
  citekeys: string[],
): Promise<{ bibFile: string; count: number }> {
  const bibFile = findBibFile(projectId);
  const unique = [...new Set(citekeys.map((k) => k.trim()).filter(Boolean))].sort();
  const entries: string[] = [];
  for (const key of unique) {
    const paper = await getPaper(key);
    entries.push(paperToBibtex(paper).trimEnd());
  }
  const header =
    "% OpenLeaf library-synced bibliography\n% Generated from cited keys — edit papers in /library\n\n";
  await writeFile(projectId, bibFile, header + entries.join("\n\n") + (entries.length ? "\n" : ""));
  return { bibFile, count: entries.length };
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
