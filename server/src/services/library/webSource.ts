/**
 * Add a web page as a library source (snapshot.txt + snapshot.json). Spec §4.2.
 */
import fsPromises from "node:fs/promises";
import { addPaper } from "./index.js";
import { ensureLibraryRoot, paperDir } from "./paths.js";
import { fetchWebPage } from "./webFetch.js";
import { extractTitleFromHtml, htmlToReadableText } from "./webText.js";
import {
  snapshotHtmlPath,
  snapshotJsonPath,
  snapshotTxtPath,
} from "./sourceText.js";
import type { PaperRecord } from "./types.js";

export type AddWebSourceInput = {
  url: string;
  title?: string;
  collections?: string[];
  notes?: string;
};

export type WebSnapshotMeta = {
  url: string;
  fetchedAt: string;
  sha256: string;
  title: string;
  bytes: number;
};

export async function addWebSource(
  input: AddWebSourceInput,
  opts?: { fetchImpl?: typeof fetch },
): Promise<{ paper: PaperRecord; snapshot: WebSnapshotMeta }> {
  const fetched = await fetchWebPage(input.url, { fetchImpl: opts?.fetchImpl });
  const html = fetched.body.toString("utf8");
  const isHtml = /html|xml/i.test(fetched.contentType) || /<html|<body|<p[\s>]/i.test(html);
  const text = isHtml ? htmlToReadableText(html) : html.replace(/\s+/g, " ").trim();
  const title =
    (input.title?.trim() || extractTitleFromHtml(html) || fetched.finalUrl).slice(0, 500) ||
    "Untitled page";

  const paper = await addPaper({
    title,
    url: fetched.finalUrl,
    source: "web",
    collections: input.collections,
    notes: input.notes,
  });

  ensureLibraryRoot();
  await fsPromises.mkdir(paperDir(paper.citekey), { recursive: true });
  await fsPromises.writeFile(snapshotTxtPath(paper.citekey), text, "utf8");
  if (isHtml) {
    // Provenance only — never served as HTML to the browser.
    await fsPromises.writeFile(snapshotHtmlPath(paper.citekey), html, "utf8");
  }
  const snapshot: WebSnapshotMeta = {
    url: fetched.finalUrl,
    fetchedAt: fetched.fetchedAt,
    sha256: fetched.sha256,
    title,
    bytes: fetched.bytes,
  };
  await fsPromises.writeFile(snapshotJsonPath(paper.citekey), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return { paper, snapshot };
}
