/**
 * Move-aware paragraph markup for latexdiff track changes.
 *
 * After sections are aligned, text that moved between sections still reads
 * as a deletion in one place and an insertion in another. Prose paragraphs
 * are paired across the two sources by word-shingle similarity; pairs that
 * fall outside the longest in-order run are treated as moved. The old copy
 * is removed and the new copy replaced by a placeholder before latexdiff, and
 * the placeholder is later filled with a latexdiff of old vs new paragraph
 * text under a "Moved text." note.
 */
import { maskComments, scanEnvs, uncommentedIndexOf } from "./trackChangesTables.js";

export const MOVED_TEXT_CMD = "OpenLeafMovedText";

export const TEXT_MOVED_PREAMBLE = [
  "%DIF OPENLEAF TEXT MOVES",
  "\\providecommand{\\OpenLeafTextMoved}{\\par\\noindent{\\protect\\color{blue}\\small\\itshape Moved text.}\\par}",
  "",
].join("\n");

/** Paragraphs inside any other environment (tables, figures, lists) are left to latexdiff. */
const PROSE_ENVS = new Set(["document", "abstract", "quote", "quotation"]);

const NOT_PROSE =
  /\\(?:begin|end)\s*\{|\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|item|bibliography|bibliographystyle|printbibliography|appendix|maketitle|input|include)(?![A-Za-z])|\\OpenLeaf/;

const MIN_WORDS = 15;
const MIN_SIMILARITY = 0.5;

type Para = { start: number; end: number; text: string; shingles: Set<string> };

function words(text: string): string[] {
  return text
    .replace(/\\[A-Za-z@]+\*?/g, " ")
    .replace(/[{}$&\\[\]~^_.,;:()"`]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function shingles(ws: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 3 <= ws.length; i++) out.add(ws.slice(i, i + 3).join(" "));
  return out;
}

export function splitProseParagraphs(tex: string): Para[] {
  const masked = maskComments(tex);
  const begin = /\\begin\s*\{document\}/.exec(masked);
  const bodyStart = begin ? begin.index + begin[0].length : 0;
  const endDoc = masked.search(/\\end\s*\{document\}/);
  const bodyEnd = endDoc < 0 ? masked.length : endDoc;
  const envs = scanEnvs(masked);
  const out: Para[] = [];
  const sep = /\n[ \t]*\n\s*/g;
  let last = bodyStart;
  const take = (s: number, e: number) => {
    while (s < e && /\s/.test(masked[s])) s += 1;
    while (e > s && /\s/.test(masked[e - 1])) e -= 1;
    if (e <= s) return;
    const m = masked.slice(s, e);
    if (NOT_PROSE.test(m)) return;
    if (envs.some((env) => env.start < s && env.end > e && !PROSE_ENVS.has(env.name))) return;
    const ws = words(m);
    if (ws.length < MIN_WORDS) return;
    out.push({ start: s, end: e, text: tex.slice(s, e), shingles: shingles(ws) });
  };
  sep.lastIndex = bodyStart;
  let m: RegExpExecArray | null;
  while ((m = sep.exec(masked)) && m.index < bodyEnd) {
    take(last, m.index);
    last = m.index + m[0].length;
  }
  take(last, bodyEnd);
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter += 1;
  return (2 * inter) / (a.size + b.size);
}

function lisKeep(seq: number[]): Set<number> {
  const n = seq.length;
  const len = new Array<number>(n).fill(1);
  const prev = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (seq[j] < seq[i] && len[j] + 1 > len[i]) {
        len[i] = len[j] + 1;
        prev[i] = j;
      }
    }
  }
  let best = -1;
  for (let i = 0; i < n; i++) if (best < 0 || len[i] > len[best]) best = i;
  const keep = new Set<number>();
  for (let i = best; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

export type MovedParagraph = { old: string; new: string; similarity: number };

export type ParagraphMoves = { old: string; new: string; blocks: Map<number, MovedParagraph> };

export function detectMovedParagraphs(oldTex: string, newTex: string): ParagraphMoves {
  const op = splitProseParagraphs(oldTex);
  const np = splitProseParagraphs(newTex);
  const cands: { ni: number; oi: number; s: number }[] = [];
  np.forEach((n, ni) => {
    op.forEach((o, oi) => {
      const s = dice(n.shingles, o.shingles);
      if (s >= MIN_SIMILARITY) cands.push({ ni, oi, s });
    });
  });
  cands.sort((a, b) => b.s - a.s);
  const byNew = new Map<number, { oi: number; s: number }>();
  const usedOld = new Set<number>();
  for (const c of cands) {
    if (byNew.has(c.ni) || usedOld.has(c.oi)) continue;
    byNew.set(c.ni, { oi: c.oi, s: c.s });
    usedOld.add(c.oi);
  }
  const pairs = [...byNew.entries()].sort((a, b) => a[0] - b[0]);
  const keep = lisKeep(pairs.map(([, v]) => v.oi));

  const blocks = new Map<number, MovedParagraph>();
  const oldRanges: { start: number; end: number; text: string }[] = [];
  const newRanges: { start: number; end: number; text: string }[] = [];
  pairs.forEach(([ni, v], k) => {
    if (keep.has(k)) return;
    const id = blocks.size + 1;
    const o = op[v.oi];
    const n = np[ni];
    blocks.set(id, { old: o.text, new: n.text, similarity: v.s });
    oldRanges.push({ start: o.start, end: o.end, text: "" });
    newRanges.push({ start: n.start, end: n.end, text: `\\${MOVED_TEXT_CMD}{${id}}` });
  });
  const apply = (tex: string, ranges: typeof oldRanges) =>
    [...ranges].sort((a, b) => b.start - a.start).reduce((t, r) => t.slice(0, r.start) + r.text + t.slice(r.end), tex);
  return { old: apply(oldTex, oldRanges), new: apply(newTex, newRanges), blocks };
}

export type MiniDiff = (oldBody: string, newBody: string) => Promise<string>;

/** Fill surviving placeholders with the paragraph's own old-vs-new markup. */
export async function renderMovedParagraphs(
  marked: string,
  blocks: Map<number, MovedParagraph>,
  diff: MiniDiff,
): Promise<string> {
  let tex = marked;
  for (const [k, p] of [...blocks.entries()].sort((a, b) => b[0] - a[0])) {
    const ph = `\\${MOVED_TEXT_CMD}{${k}}`;
    const hits = uncommentedIndexOf(tex, ph);
    if (!hits.length) continue;
    const body = p.old.trim() === p.new.trim() ? p.new : await diff(p.old, p.new);
    for (const at of hits.reverse()) {
      tex = `${tex.slice(0, at)}\\OpenLeafTextMoved\n${body}${tex.slice(at + ph.length)}`;
    }
  }
  return tex;
}
