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

export type SnapshotProvenance = "fetched" | "curated" | "pasted" | "uploaded";

export type WebSnapshotMeta = {
  url: string;
  fetchedAt: string;
  sha256: string;
  title: string;
  bytes: number;
  /** How the snapshot text entered OpenLeaf. Omitted on legacy files → treat as fetched if sha256 looks real. */
  provenance?: SnapshotProvenance;
  /** Human note (e.g. why a curated excerpt was used). */
  note?: string;
};

export function describeSnapshotProvenance(meta: Partial<WebSnapshotMeta> | null | undefined): string {
  const p = meta?.provenance;
  const when = meta?.fetchedAt ? meta.fetchedAt.slice(0, 10) : null;
  if (p === "curated") {
    return when
      ? `Text pasted by an agent (curated excerpt) · ${when}`
      : "Text pasted by an agent (curated excerpt)";
  }
  if (p === "pasted") {
    return when ? `Text pasted by an agent · ${when}` : "Text pasted by an agent";
  }
  if (p === "uploaded") {
    return when ? `Uploaded by you · ${when}` : "Uploaded by you";
  }
  if (p === "fetched" || (!p && meta?.fetchedAt)) {
    return when ? `Fetched by OpenLeaf on ${when}` : "Fetched by OpenLeaf";
  }
  return "Source snapshot";
}

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
    provenance: "fetched",
  };
  await fsPromises.writeFile(snapshotJsonPath(paper.citekey), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return { paper, snapshot };
}
