/** Shared helpers for attaching a PDF to a library paper via drag-drop / file picker. */
import { attachLibraryPdf, getLibraryPdfReplacePreview } from "../api/client";
import type { PaperRecord } from "../api/types";

export function isPdfFile(file: File): boolean {
  if (file.type === "application/pdf") return true;
  return /\.pdf$/i.test(file.name);
}

export async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export type PdfReplacePreview = {
  file: File;
  taggedFactCount: number;
  totalFacts: number;
};

export async function previewPdfReplace(citekey: string, file: File): Promise<PdfReplacePreview> {
  try {
    const preview = await getLibraryPdfReplacePreview(citekey);
    return {
      file,
      taggedFactCount: preview.taggedFactCount,
      totalFacts: preview.totalFacts,
    };
  } catch {
    return { file, taggedFactCount: 0, totalFacts: 0 };
  }
}

export async function uploadPaperPdf(
  citekey: string,
  file: File,
  replace: boolean,
): Promise<{ paper: PaperRecord; replaced: boolean; factsUntagged: number }> {
  if (!isPdfFile(file)) {
    throw new Error("Only PDF files can be uploaded.");
  }
  const pdfBase64 = await fileToBase64(file);
  const head = atob(pdfBase64.slice(0, 16));
  if (!head.startsWith("%PDF-")) {
    throw new Error("File is not a PDF (missing %PDF- header).");
  }
  return attachLibraryPdf(citekey, { pdfBase64, replace });
}
