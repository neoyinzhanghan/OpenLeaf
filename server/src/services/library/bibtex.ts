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

const SKIP_TYPES = new Set(["string", "comment", "preamble"]);

/** Read one `{...}` body starting at `open`, honoring nested braces and quotes. */
function readBraceBody(text: string, open: number): { body: string; end: number } | null {
  if (text[open] !== "{") return null;
  let depth = 1;
  let quote = false;
  for (let i = open + 1; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') {
      quote = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

export function parseBibtex(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("@", i);
    if (at < 0) break;
    const head = /^@(\w+)\s*\{/.exec(text.slice(at));
    if (!head) {
      i = at + 1;
      continue;
    }
    const type = head[1]!.toLowerCase();
    const braceAt = at + head[0].length - 1;
    const wrapped = readBraceBody(text, braceAt);
    if (!wrapped) {
      i = at + 1;
      continue;
    }
    i = wrapped.end;
    if (SKIP_TYPES.has(type)) continue;
    const comma = wrapped.body.indexOf(",");
    if (comma < 0) continue;
    const citekey = wrapped.body.slice(0, comma).trim();
    if (!citekey || /\s/.test(citekey)) continue;
    const body = wrapped.body.slice(comma + 1);
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

function arxivIdFromBibFields(fields: Record<string, string>, urlFromHow: string | null): string | null {
  if (fields.arxiv?.trim()) return fields.arxiv.trim();
  const eprint = fields.eprint?.trim();
  const prefix = `${fields.archiveprefix ?? ""} ${fields.eprinttype ?? ""}`.toLowerCase();
  if (eprint && (prefix.includes("arxiv") || /arxiv/i.test(eprint) || /^\d{4}\.\d{4,5}(v\d+)?$/i.test(eprint))) {
    return eprint.replace(/^arxiv:/i, "");
  }
  const url = fields.url || urlFromHow || "";
  const fromUrl = url.match(/arxiv\.org\/(?:abs|pdf)\/([^/?#]+)/i)?.[1];
  return fromUrl ? fromUrl.replace(/\.pdf$/i, "") : null;
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
    arxivId: arxivIdFromBibFields(f, urlFromHow),
    url: f.url || urlFromHow,
    notes: "",
    tags: [],
    collections: [],
    source: "bibtex-import",
  };
}
