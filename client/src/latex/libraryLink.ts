/** A compiled citation link: PDF user space, origin at the bottom left. */
export type PdfCiteLink = {
  citekey: string;
  rect: readonly number[];
};

/**
 * Hyperref names in-text citation links `cite.<key>`, and some styles use
 * `cite.<n>@<key>`. Other destinations (sections, pages) are ignored.
 */
export function citekeyFromPdfDest(dest: unknown): string | null {
  if (typeof dest !== "string" || !dest.startsWith("cite.")) return null;
  let key = dest.slice("cite.".length);
  const at = key.lastIndexOf("@");
  if (at >= 0) key = key.slice(at + 1);
  key = key.trim();
  if (!key || /[\s{}\\]/.test(key)) return null;
  return key;
}

/**
 * Hit-test citation links. `x` and `yFromTop` are PDF points with the origin
 * at the top left, matching a click on the rendered page.
 */
export function citationLinkAtPoint(
  links: readonly PdfCiteLink[],
  x: number,
  yFromTop: number,
  pageHeight: number,
): string | null {
  const y = pageHeight - yFromTop;
  let best: { citekey: string; area: number } | null = null;
  for (const link of links) {
    if (link.rect.length < 4) continue;
    const [x1, y1, x2, y2] = link.rect;
    const left = Math.min(x1!, x2!);
    const right = Math.max(x1!, x2!);
    const bottom = Math.min(y1!, y2!);
    const top = Math.max(y1!, y2!);
    if (x < left || x > right || y < bottom || y > top) continue;
    const area = Math.max(1, (right - left) * (top - bottom));
    if (!best || area < best.area) best = { citekey: link.citekey, area };
  }
  return best?.citekey ?? null;
}

/** Library page that opens one paper. Absolute so the editor hover opens a new tab. */
export function libraryPaperUrl(citekey: string): string {
  const origin = typeof location !== "undefined" ? location.origin : "http://localhost";
  const url = new URL("/library", origin);
  url.searchParams.set("paper", citekey);
  return url.toString();
}

/** Facts review for one paper (or the whole queue). Absolute for new-tab opens. */
export function libraryFactsUrl(opts?: { citekey?: string; factId?: string; status?: string }): string {
  const origin = typeof location !== "undefined" ? location.origin : "http://localhost";
  const url = new URL("/facts", origin);
  if (opts?.citekey) url.searchParams.set("paper", opts.citekey);
  if (opts?.factId) url.searchParams.set("fact", opts.factId);
  if (opts?.status) url.searchParams.set("status", opts.status);
  return url.toString();
}
