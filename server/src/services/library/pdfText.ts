/**
 * Extract a PDF's text layer for fact quote matching.
 * Character offsets are into each page's concatenated text; item geometry uses
 * the same top-left / y-down PDF-point space as PdfViewer annotations.
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { getPaper } from "./index.js";
import { attachmentPath, ensureLibraryRoot, paperDir, pdfTextCachePath } from "./paths.js";

export type PdfTextItem = {
  str: string;
  start: number;
  end: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** True when the text x-axis is closer to vertical (90°-rotated table glyphs). */
  rotated?: boolean;
};

export type PdfTextPage = {
  page: number;
  width: number;
  height: number;
  text: string;
  items: PdfTextItem[];
};

export type PdfTextCache = {
  /** v2: axis-aligned bounds from full pdf.js text transform (handles 90° tables). */
  version: 1 | 2;
  extractedAt: string;
  sourceBytes: number;
  sourceMtimeMs: number;
  pages: PdfTextPage[];
};

const PDF_TEXT_CACHE_VERSION = 2 as const;

export type FactHighlight = {
  page: number;
  /** Inclusive start offset in that page's `text`. */
  start: number;
  /** Exclusive end offset in that page's `text`. */
  end: number;
  quote: string;
};

export type FactDisplayRect = {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Glyph layout in the PDF text layer:
   * - "v": stacked / rotated table digits (tall column)
   * - "h": normal left-to-right run (wide row cell)
   */
  orient?: "h" | "v";
};

export type PdfTextCapability =
  | { ok: true; pages: number; chars: number }
  | { ok: false; reason: "no-pdf" | "no-text" };

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const require = createRequire(import.meta.url);

async function loadPdfjs(): Promise<{
  getDocument: (src: unknown) => { promise: Promise<PdfDocument> };
}> {
  const pkgPath = require.resolve("pdfjs-dist/package.json");
  const legacy = pathToFileURL(
    pkgPath.replace(/package\.json$/, "legacy/build/pdf.mjs"),
  ).href;
  return import(legacy) as Promise<{
    getDocument: (src: unknown) => { promise: Promise<PdfDocument> };
  }>;
}

type PdfDocument = {
  numPages: number;
  getPage: (n: number) => Promise<{
    getViewport: (opts: { scale: number }) => { width: number; height: number };
    getTextContent: () => Promise<{
      items: Array<
        | { str: string; transform: number[]; width: number; height: number; hasEOL?: boolean }
        | { type?: string }
      >;
    }>;
  }>;
  destroy: () => Promise<void>;
};

function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Map an index in whitespace-collapsed text back to the original string. */
function mapCollapsedIndex(original: string, collapsedIndex: number): number {
  let oi = 0;
  let ci = 0;
  const n = original.length;
  while (oi < n && /\s/.test(original[oi]!)) oi += 1;
  while (oi < n && ci < collapsedIndex) {
    const ch = original[oi]!;
    if (/\s/.test(ch)) {
      while (oi < n && /\s/.test(original[oi]!)) oi += 1;
      ci += 1;
    } else {
      oi += 1;
      ci += 1;
    }
  }
  return oi;
}

/** True when needle looks like a printed number / percent (avoid "92.1" inside "95.592.16"). */
function looksNumericToken(needle: string): boolean {
  return /^[\d.]+%?$/.test(needle.trim());
}

/**
 * Avoid "92.1" inside "95.592.16", but allow:
 * - trailing precision ("0.932" in "0.9320 ±") — expand the hit to cover those zeros
 * - glued table cells ("0.9750.004", "95.592.16")
 * Never start mid-number.
 */
function hasNumericTokenBoundary(hay: string, at: number, len: number): boolean {
  const before = at > 0 ? hay[at - 1]! : "";
  if (/[\d.]/.test(before)) return false;
  const after = hay.slice(at + len);
  if (!after || !/^[\d.]/.test(after)) return true;
  // Same number with trailing zeros only: 0.932 in 0.9320 ± (not 92.1 in 92.11).
  if (/^0+(?:±|%|,|;|:|\s|$)/.test(after)) return true;
  // Glued next measurement: "...0.9750.004..." or "...95.592.16..."
  if (/^0\.\d/.test(after)) return true;
  if (/^\d{1,3}\.\d/.test(after) && /\.\d+$/.test(hay.slice(at, at + len))) return true;
  return false;
}

/** Grow a numeric match through trailing printed zeros ("0.94" → "0.940"). */
function expandNumericMatchLength(hay: string, at: number, len: number): number {
  let end = at + len;
  const after = hay.slice(end);
  const m = after.match(/^0+(?=[±%%,;:\s]|$)/);
  if (m) end += m[0].length;
  return end - at;
}

/** Shrink a wide table-row hit down to the printed answer token inside it. */
export function tightenHighlightToAnswer(
  hit: FactHighlight,
  page: PdfTextPage,
  answer: string,
): FactHighlight {
  const raw = String(answer ?? "").trim();
  if (!raw || hit.end <= hit.start) return hit;
  const slice = page.text.slice(hit.start, hit.end);
  if (!slice) return hit;
  const candidates = new Set<string>([raw]);
  const d = Number(raw);
  if (Number.isFinite(d)) {
    for (const n of [d.toFixed(4), d.toFixed(3), d.toFixed(2), String(d)]) candidates.add(n);
    const pct = d * 100;
    for (const n of [pct.toFixed(2), pct.toFixed(1), pct.toFixed(0)]) candidates.add(n);
  }
  const ordered = [...candidates].filter((s) => s.length >= 2).sort((a, b) => b.length - a.length);
  for (const v of ordered) {
    const at = slice.indexOf(v);
    if (at < 0) continue;
    let len = v.length;
    if (looksNumericToken(v)) {
      len = expandNumericMatchLength(slice, at, len);
    }
    const start = hit.start + at;
    const end = start + len;
    if (end <= start || end > hit.end + 2) continue;
    return {
      page: hit.page,
      start,
      end: Math.min(end, page.text.length),
      quote: page.text.slice(start, Math.min(end, page.text.length)),
    };
  }
  return hit;
}

export function locateQuoteInPages(pages: PdfTextPage[], quote: string): FactHighlight[] {
  const needle = normalizeForMatch(quote);
  if (!needle) return [];
  const numeric = looksNumericToken(needle);
  const hits: FactHighlight[] = [];
  for (const page of pages) {
    const hay = normalizeForMatch(page.text);
    if (!hay) continue;
    let from = 0;
    while (from <= hay.length) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      from = at + Math.max(1, needle.length);
      if (numeric && !hasNumericTokenBoundary(hay, at, needle.length)) continue;
      const matchLen = numeric ? expandNumericMatchLength(hay, at, needle.length) : needle.length;
      const start = mapCollapsedIndex(page.text, at);
      const end = mapCollapsedIndex(page.text, at + matchLen);
      const exact = page.text.slice(start, end);
      hits.push({
        page: page.page,
        start,
        end,
        quote: exact || quote.trim(),
      });
      if (hits.length >= 8) return hits;
    }
  }
  return hits;
}

/**
 * Axis-aligned viewport bounds (top-left, y-down) for a pdf.js text item,
 * honoring rotation in `transform` (critical for 90° table numbers).
 */
export function transformItemBounds(
  transform: number[],
  width: number,
  height: number,
  pageHeight: number,
): { x: number; y: number; w: number; h: number; rotated: boolean } {
  const a = transform[0] ?? 0;
  const b = transform[1] ?? 0;
  const c = transform[2] ?? 0;
  const d = transform[3] ?? 0;
  const e = transform[4] ?? 0;
  const f = transform[5] ?? 0;
  const sx = Math.hypot(a, b) || 1;
  const sy = Math.hypot(c, d) || 1;
  const ax = (a / sx) * width;
  const ay = (b / sx) * width;
  const fontH = height > 0 ? height : sy;
  const hx = (c / sy) * fontH;
  const hy = (d / sy) * fontH;
  const xs = [e, e + ax, e + hx, e + ax + hx];
  const ys = [f, f + ay, f + hy, f + ay + hy];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  // Text baseline advances more vertically than horizontally → rotated column glyph.
  const rotated = Math.abs(b) > Math.abs(a) * 0.75;
  return {
    x: minX,
    y: pageHeight - maxY,
    w: Math.max(0.5, maxX - minX),
    h: Math.max(0.5, maxY - minY),
    rotated,
  };
}

/** Infer whether glyphs read as a vertical column (rotated table) or horizontal run. */
export function detectTextOrient(items: PdfTextItem[]): "h" | "v" {
  if (!items.length) return "h";
  if (items.some((it) => it.rotated)) {
    // Rotated runs are columns even when a single token looks "wide" in raw width.
    const x = Math.min(...items.map((i) => i.x));
    const y = Math.min(...items.map((i) => i.y));
    const w = Math.max(...items.map((i) => i.x + i.w)) - x;
    const h = Math.max(...items.map((i) => i.y + i.h)) - y;
    return h >= w * 0.9 ? "v" : "h";
  }
  if (items.length === 1) {
    const it = items[0]!;
    return it.h > it.w * 1.6 && it.h >= 14 ? "v" : "h";
  }
  const xs = items.map((i) => i.x);
  const ys = items.map((i) => i.y);
  const dx = Math.max(...xs) - Math.min(...xs);
  const dy = Math.max(...ys) - Math.min(...ys);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const w = Math.max(...items.map((i) => i.x + i.w)) - x;
  const h = Math.max(...items.map((i) => i.y + i.h)) - y;
  if (dy > dx + 2 && h >= w * 1.25) return "v";
  if (dx > dy + 2 && w >= h * 1.25) return "h";
  return h > w * 1.4 ? "v" : "h";
}

/** Clip an item's box to the character-range overlap (tighter number-only highlights). */
function clipItemToRange(item: PdfTextItem, start: number, end: number): PdfTextItem {
  const span = Math.max(1, item.end - item.start);
  const lo = Math.max(0, Math.min(1, (Math.max(start, item.start) - item.start) / span));
  const hi = Math.max(lo, Math.min(1, (Math.min(end, item.end) - item.start) / span));
  if (lo <= 0.001 && hi >= 0.999) return item;
  if (item.rotated || item.h > item.w * 1.25) {
    // Vertical: clip along Y (reading direction).
    const y = item.y + item.h * lo;
    const h = Math.max(0.5, item.h * (hi - lo));
    return { ...item, y, h };
  }
  const x = item.x + item.w * lo;
  const w = Math.max(0.5, item.w * (hi - lo));
  return { ...item, x, w };
}

function itemsBounds(items: PdfTextItem[], page: number): FactDisplayRect {
  const x = Math.min(...items.map((i) => i.x));
  const y = Math.min(...items.map((i) => i.y));
  const right = Math.max(...items.map((i) => i.x + i.w));
  const bottom = Math.max(...items.map((i) => i.y + i.h));
  const orient = detectTextOrient(items);
  let w = Math.max(1, right - x);
  let h = Math.max(1, bottom - y);
  // Light pad only — keep the box tight to the ink.
  if (orient === "v") {
    const padX = Math.max(1, Math.min(2.5, w * 0.2));
    const padY = Math.max(0.5, Math.min(2, h * 0.06));
    return {
      page,
      x: Math.max(0, x - padX),
      y: Math.max(0, y - padY),
      w: Math.max(w + padX * 2, 8),
      h: Math.max(h + padY * 2, 10),
      orient,
    };
  }
  const padY = Math.max(0.5, Math.min(2, h * 0.2));
  const padX = Math.max(0.5, Math.min(2, w * 0.04));
  return {
    page,
    x: Math.max(0, x - padX),
    y: Math.max(0, y - padY),
    w: Math.max(w + padX * 2, 6),
    h: Math.max(h + padY * 2, 7),
    orient,
  };
}

/**
 * Map a page-space bbox (top-left, y-down PDF points) to text-layer highlights
 * by intersecting glyph boxes. Used for human bbox / text-region tagging.
 */
export function highlightsFromPageRect(
  page: PdfTextPage,
  rect: { x: number; y: number; w: number; h: number },
): FactHighlight[] {
  const x0 = rect.x;
  const y0 = rect.y;
  const x1 = rect.x + rect.w;
  const y1 = rect.y + rect.h;
  const hits = page.items.filter((it) => {
    const ix0 = it.x;
    const iy0 = it.y;
    const ix1 = it.x + it.w;
    const iy1 = it.y + it.h;
    const overlapX = Math.min(x1, ix1) - Math.max(x0, ix0);
    const overlapY = Math.min(y1, iy1) - Math.max(y0, iy0);
    if (overlapX <= 0 || overlapY <= 0) return false;
    const area = Math.max(it.w * it.h, 1);
    return (overlapX * overlapY) / area >= 0.25;
  });
  if (!hits.length) return [];
  hits.sort((a, b) => a.start - b.start);
  // Merge contiguous / near-contiguous runs into spans.
  const spans: Array<{ start: number; end: number }> = [];
  for (const it of hits) {
    const last = spans[spans.length - 1];
    if (last && it.start <= last.end + 2) {
      last.end = Math.max(last.end, it.end);
    } else {
      spans.push({ start: it.start, end: it.end });
    }
  }
  return spans
    .filter((s) => s.end > s.start)
    .slice(0, 4)
    .map((s) => ({
      page: page.page,
      start: s.start,
      end: s.end,
      quote: page.text.slice(s.start, s.end),
    }));
}

export function offsetsToRects(page: PdfTextPage, start: number, end: number): FactDisplayRect[] {
  if (end <= start) return [];
  const overlapping = page.items
    .filter((it) => it.end > start && it.start < end)
    .map((it) => clipItemToRange(it, start, end));
  if (!overlapping.length) {
    return [{ page: page.page, x: 72, y: 72, w: Math.min(160, page.width - 72), h: 14, orient: "h" }];
  }
  // Short value tokens (incl. vertically stacked / rotated table glyphs) → one cell bbox.
  const span = end - start;
  if (span <= 32 || overlapping.length <= 12) {
    return [itemsBounds(overlapping, page.page)];
  }
  const orient = detectTextOrient(overlapping);
  if (orient === "v") {
    return [itemsBounds(overlapping, page.page)];
  }
  const byLine = new Map<string, PdfTextItem[]>();
  for (const it of overlapping) {
    const key = String(Math.round(it.y * 2) / 2);
    const list = byLine.get(key) ?? [];
    list.push(it);
    byLine.set(key, list);
  }
  const rects: FactDisplayRect[] = [];
  for (const items of byLine.values()) {
    rects.push(itemsBounds(items, page.page));
  }
  return rects;
}

export function highlightDisplayRects(
  pages: PdfTextPage[],
  highlights: FactHighlight[],
): FactDisplayRect[] {
  const out: FactDisplayRect[] = [];
  for (const h of highlights) {
    const page = pages.find((p) => p.page === h.page);
    if (!page) continue;
    out.push(...offsetsToRects(page, h.start, h.end));
  }
  return out;
}

async function extractFromPdfBytes(data: Uint8Array): Promise<PdfTextPage[]> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
  });
  const doc = await task.promise;
  try {
    const pages: PdfTextPage[] = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      let text = "";
      for (const raw of content.items) {
        if (!("str" in raw) || typeof raw.str !== "string") continue;
        const str = raw.str;
        if (!str) continue;
        const tr = raw.transform ?? [1, 0, 0, 1, 0, 0];
        const width = Number(raw.width) || 0;
        const height = Number(raw.height) || 0;
        const box = transformItemBounds(tr, width, height, viewport.height);
        const start = text.length;
        text += str;
        const end = text.length;
        items.push({
          str,
          start,
          end,
          x: Math.max(0, box.x),
          y: Math.max(0, box.y),
          w: Math.max(0.5, box.w),
          h: Math.max(0.5, box.h),
          rotated: box.rotated,
        });
        if (raw.hasEOL) text += "\n";
      }
      pages.push({
        page: pageNum,
        width: viewport.width,
        height: viewport.height,
        text,
        items,
      });
    }
    return pages;
  } finally {
    await doc.destroy();
  }
}

export async function readPdfTextCache(citekey: string): Promise<PdfTextCache | null> {
  const file = pdfTextCachePath(citekey);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(await fsPromises.readFile(file, "utf8")) as PdfTextCache;
    if ((raw?.version !== 1 && raw?.version !== 2) || !Array.isArray(raw.pages)) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function getPdfTextForPaper(citekey: string, opts?: { force?: boolean }): Promise<PdfTextCache> {
  await getPaper(citekey);
  const pdfPath = attachmentPath(citekey);
  if (!fs.existsSync(pdfPath)) throw httpError(404, "No PDF attached");
  const st = fs.statSync(pdfPath);
  if (!opts?.force) {
    const cached = await readPdfTextCache(citekey);
    if (
      cached &&
      cached.version === PDF_TEXT_CACHE_VERSION &&
      cached.sourceBytes === st.size &&
      Math.abs(cached.sourceMtimeMs - st.mtimeMs) < 1
    ) {
      return cached;
    }
  }
  const buf = await fsPromises.readFile(pdfPath);
  const pages = await extractFromPdfBytes(new Uint8Array(buf));
  const cache: PdfTextCache = {
    version: PDF_TEXT_CACHE_VERSION,
    extractedAt: new Date().toISOString(),
    sourceBytes: st.size,
    sourceMtimeMs: st.mtimeMs,
    pages,
  };
  ensureLibraryRoot();
  await fsPromises.mkdir(paperDir(citekey), { recursive: true });
  await fsPromises.writeFile(pdfTextCachePath(citekey), `${JSON.stringify(cache)}\n`, "utf8");
  return cache;
}

export async function pdfTextCapability(citekey: string): Promise<PdfTextCapability> {
  try {
    await getPaper(citekey);
  } catch (err) {
    throw err;
  }
  if (!fs.existsSync(attachmentPath(citekey))) return { ok: false, reason: "no-pdf" };
  try {
    const cache = await getPdfTextForPaper(citekey);
    const chars = cache.pages.reduce((n, p) => n + p.text.replace(/\s+/g, "").length, 0);
    if (chars < 40) return { ok: false, reason: "no-text" };
    return { ok: true, pages: cache.pages.length, chars };
  } catch {
    return { ok: false, reason: "no-text" };
  }
}
