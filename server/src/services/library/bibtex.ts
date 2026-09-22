/**
 * Minimal BibTeX parser for library import — enough for @article/@inproceedings/etc.
 * Not a full BibTeX grammar; good enough for Crossref/Zotero exports.
 */
import type { CreatePaperInput } from "./types.js";

export type BibEntry = {
  type: string;
  citekey: string;
  fields: Record<string, string>;
};

function stripBraces(value: string): string {
  let v = value.trim();
  if (v.startsWith("{") && v.endsWith("}")) v = v.slice(1, -1);
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  return v.replace(/\s+/g, " ").trim();
}

export function parseBibtex(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const re = /@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)\n\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const type = m[1]!.toLowerCase();
    const citekey = m[2]!;
    const body = m[3]!;
    const fields: Record<string, string> = {};
    const fieldRe = /(\w+)\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\}|"[^"]*"|[^,\n]+)/g;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(body))) {
      fields[fm[1]!.toLowerCase()] = stripBraces(fm[2]!);
    }
    entries.push({ type, citekey, fields });
  }
  return entries;
}

function parseAuthors(authorField: string): Array<{ given: string; family: string }> {
  return authorField
    .split(/\s+and\s+/i)
    .map((a) => a.trim())
    .filter(Boolean)
    .map((name) => {
      if (name.includes(",")) {
        const [family, given] = name.split(",").map((s) => s.trim());
        return { given: given ?? "", family: family || "Unknown" };
      }
      const parts = name.split(/\s+/);
      if (parts.length === 1) return { given: "", family: parts[0]! };
      return { given: parts.slice(0, -1).join(" "), family: parts[parts.length - 1]! };
    });
}

export function bibEntryToCreateInput(entry: BibEntry): CreatePaperInput {
  const f = entry.fields;
  const yearRaw = f.year ? Number(f.year.slice(0, 4)) : null;
  const howpublished = f.howpublished || "";
  const urlFromHow =
    howpublished.match(/https?:\/\/[^\s}\\]+/i)?.[0] ??
    howpublished.match(/\\url\{([^}]+)\}/i)?.[1] ??
    null;
  return {
    citekey: entry.citekey,
    title: f.title || entry.citekey,
    authors: f.author ? parseAuthors(f.author) : [],
    year: Number.isFinite(yearRaw) ? yearRaw : null,
    venue: f.journal || f.booktitle || f.publisher || "",
    abstract: f.abstract || "",
    doi: f.doi ? f.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "") : null,
    arxivId: f.eprint && /arxiv/i.test(f.archiveprefix ?? f.eprint ?? "") ? f.eprint : f.arxiv ?? null,
    url: f.url || urlFromHow,
    notes: "",
    tags: [],
    collections: [],
    source: "bibtex-import",
  };
}
