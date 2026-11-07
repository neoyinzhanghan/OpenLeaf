/**
 * Shared source-text abstraction for PDF and web facts. Spec §4.2.
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { getPaper } from "./index.js";
import { paperDir } from "./paths.js";
import { getPdfTextForPaper, type PdfTextCapability, type PdfTextPage } from "./pdfText.js";

export type SourceTextPages = PdfTextPage[];

export type SourceTextCapability =
  | { ok: true; kind: "pdf" | "web"; pages: number; chars: number }
  | { ok: false; reason: "no-source" | "no-text"; kind?: "pdf" | "web" };

export function snapshotTxtPath(citekey: string): string {
  return path.join(paperDir(citekey), "snapshot.txt");
}

export function snapshotJsonPath(citekey: string): string {
  return path.join(paperDir(citekey), "snapshot.json");
}

export function snapshotHtmlPath(citekey: string): string {
  return path.join(paperDir(citekey), "snapshot.html");
}

export async function getSourceText(citekey: string): Promise<{
  kind: "pdf" | "web";
  pages: SourceTextPages;
}> {
  const paper = await getPaper(citekey);
  if (paper.source === "web" || fs.existsSync(snapshotTxtPath(citekey))) {
    const text = await fsPromises.readFile(snapshotTxtPath(citekey), "utf8");
    const pages: SourceTextPages = [
      {
        page: 1,
        width: 612,
        height: 792,
        text,
        items: text
          ? [{ str: text, start: 0, end: text.length, x: 0, y: 0, w: 612, h: 12 }]
          : [],
      },
    ];
    return { kind: "web", pages };
  }
  const cache = await getPdfTextForPaper(citekey);
  return { kind: "pdf", pages: cache.pages };
}

export async function sourceTextCapability(citekey: string): Promise<SourceTextCapability> {
  const paper = await getPaper(citekey);
  if (paper.source === "web" || fs.existsSync(snapshotTxtPath(citekey))) {
    try {
      const text = await fsPromises.readFile(snapshotTxtPath(citekey), "utf8");
      if (!text.trim()) return { ok: false, reason: "no-text", kind: "web" };
      return { ok: true, kind: "web", pages: 1, chars: text.length };
    } catch {
      return { ok: false, reason: "no-source", kind: "web" };
    }
  }
  // PDF path — reuse existing capability shape.
  const { pdfTextCapability } = await import("./pdfText.js");
  const cap: PdfTextCapability = await pdfTextCapability(citekey);
  if (!cap.ok) {
    return { ok: false, reason: cap.reason === "no-pdf" ? "no-source" : "no-text", kind: "pdf" };
  }
  return { ok: true, kind: "pdf", pages: cap.pages, chars: cap.chars };
}
