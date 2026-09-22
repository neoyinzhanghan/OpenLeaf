import type { ArxivClient, ResolvedAuthor, ResolvedPaper } from "./types.js";
import { readLookupCache, writeLookupCache } from "./lookupCache.js";

const ARXIV_API = "https://export.arxiv.org/api/query";

function textContent(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() ?? "";
}

function allTextContents(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    out.push(m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim());
  }
  return out;
}

function normalizeArxivId(id: string): string {
  return id
    .trim()
    .replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, "")
    .replace(/\.pdf$/i, "")
    .replace(/^arxiv:/i, "");
}

function parseAtomEntry(entryXml: string, arxivId: string): ResolvedPaper | null {
  const title = textContent(entryXml, "title").replace(/\s+/g, " ");
  if (!title) return null;
  const authors: ResolvedAuthor[] = allTextContents(entryXml, "name").map((name) => {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return { given: "", family: parts[0]! };
    return { given: parts.slice(0, -1).join(" "), family: parts[parts.length - 1]! };
  });
  const published = textContent(entryXml, "published");
  const year = published ? Number(published.slice(0, 4)) : null;
  const abstract = textContent(entryXml, "summary").replace(/\s+/g, " ");
  const doiMatch = entryXml.match(/arxiv:doi[^>]*>([^<]+)/i);
  const doi = doiMatch?.[1]?.trim() ?? null;
  return {
    doi,
    arxivId,
    title,
    authors,
    venue: "arXiv",
    year: Number.isFinite(year) ? year : null,
    abstract,
    source: "arxiv",
    raw: entryXml,
  };
}

export function createArxivClient(opts?: { fetchImpl?: typeof fetch }): ArxivClient {
  const fetchImpl = opts?.fetchImpl ?? fetch;

  return {
    async lookupId(arxivId: string): Promise<ResolvedPaper | null> {
      const id = normalizeArxivId(arxivId);
      if (!id) return null;
      const cached = await readLookupCache<ResolvedPaper>("arxiv", id);
      if (cached) return cached;
      const url = `${ARXIV_API}?id_list=${encodeURIComponent(id)}`;
      const res = await fetchImpl(url, {
        headers: { Accept: "application/atom+xml", "User-Agent": "OpenLeaf/1.0" },
      });
      if (!res.ok) throw Object.assign(new Error(`arXiv HTTP ${res.status}`), { status: 502 });
      const xml = await res.text();
      const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/i);
      if (!entryMatch) return null;
      const paper = parseAtomEntry(entryMatch[1]!, id);
      if (paper) await writeLookupCache("arxiv", id, paper);
      return paper;
    },
  };
}

export { normalizeArxivId };
