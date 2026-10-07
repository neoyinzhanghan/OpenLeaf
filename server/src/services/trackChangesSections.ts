/**
 * Move-aware section alignment for latexdiff track changes.
 *
 * latexdiff has no notion of a move: a reordered section shows up as a full
 * deletion plus a full insertion. Before diffing, split both sources into
 * heading blocks, pair them by \label or title, and rearrange the old source
 * into the new order so each section is diffed against its own old text.
 * Blocks that actually moved get an identical \OpenLeafSectionMoved line in
 * both sources, which latexdiff passes through unchanged. Subsections are
 * aligned the same way within their matched parent.
 */
import { groupEnd, jaccard, maskComments, skipSpace, wordSet } from "./trackChangesTables.js";

export const SECTION_MOVED_CMD = "OpenLeafSectionMoved";

export const SECTION_MOVED_PREAMBLE = [
  "%DIF OPENLEAF SECTION MOVES",
  `\\providecommand{\\${SECTION_MOVED_CMD}}{\\par\\noindent{\\protect\\color{blue}\\small\\itshape Section moved.}\\par}`,
  "",
].join("\n");

const LEVELS = ["part", "chapter", "section", "subsection", "subsubsection"];

/** The sectioned region ends here; bibliography, appendices and back matter stay in place. */
const REGION_STOP =
  /\\(?:bibliography|bibliographystyle|printbibliography|appendix|backmatter)(?![A-Za-z])|\\begin\s*\{thebibliography\}|\\end\s*\{document\}/;

type Block = {
  start: number;
  end: number;
  /** Index just past the heading (and an immediately following \label). */
  headEnd: number;
  title: string;
  label: string | null;
};

type Split = { head: string; blocks: Block[]; tail: string; text: string };

function splitBlocks(text: string, level: string): Split {
  const masked = maskComments(text);
  const stop = masked.search(REGION_STOP);
  const regionEnd = stop < 0 ? text.length : stop;
  const re = new RegExp(String.raw`\\${level}(?![A-Za-z])\*?`, "g");
  const starts: { at: number; headEnd: number; title: string; label: string | null }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) && m.index < regionEnd) {
    let i = skipSpace(masked, m.index + m[0].length);
    if (masked[i] === "[") {
      const e = groupEnd(masked, i);
      if (e < 0) continue;
      i = skipSpace(masked, e);
    }
    if (masked[i] !== "{") continue;
    const titleEnd = groupEnd(masked, i);
    if (titleEnd < 0) continue;
    const title = text.slice(i + 1, titleEnd - 1);
    let headEnd = titleEnd;
    let label: string | null = null;
    const lm = /^\s*\\label\s*\{([^}]+)\}/.exec(masked.slice(titleEnd));
    if (lm) {
      label = lm[1].trim();
      headEnd = titleEnd + lm[0].length;
    }
    starts.push({ at: m.index, headEnd, title, label });
    re.lastIndex = titleEnd;
  }
  if (!starts.length) return { head: text, blocks: [], tail: "", text };
  const blocks: Block[] = starts.map((s, k) => ({
    start: s.at,
    end: k + 1 < starts.length ? starts[k + 1].at : regionEnd,
    headEnd: s.headEnd,
    title: s.title,
    label: s.label,
  }));
  return {
    head: text.slice(0, blocks[0].start),
    blocks,
    tail: text.slice(regionEnd),
    text,
  };
}

function normTitle(t: string): string {
  return t
    .replace(/\\[A-Za-z@]+\*?/g, " ")
    .replace(/[{}$\\~^_.,;:()\-–—'"`]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** new index → old index */
function matchBlocks(oldB: Block[], newB: Block[]): Map<number, number> {
  const match = new Map<number, number>();
  const used = new Set<number>();
  const pass = (eq: (o: Block, n: Block) => boolean) => {
    newB.forEach((n, ni) => {
      if (match.has(ni)) return;
      const oi = oldB.findIndex((o, i) => !used.has(i) && eq(o, n));
      if (oi >= 0) {
        match.set(ni, oi);
        used.add(oi);
      }
    });
  };
  pass((o, n) => !!o.label && o.label === n.label);
  pass((o, n) => normTitle(o.title) === normTitle(n.title) && normTitle(n.title) !== "");
  const cands: { ni: number; oi: number; s: number }[] = [];
  newB.forEach((n, ni) => {
    if (match.has(ni)) return;
    oldB.forEach((o, oi) => {
      if (used.has(oi)) return;
      const s = jaccard(wordSet(normTitle(o.title)), wordSet(normTitle(n.title)));
      if (s >= 0.6) cands.push({ ni, oi, s });
    });
  });
  cands.sort((a, b) => b.s - a.s);
  for (const c of cands) {
    if (match.has(c.ni) || used.has(c.oi)) continue;
    match.set(c.ni, c.oi);
    used.add(c.oi);
  }
  return match;
}

/** Indices (into `seq`) that lie on one longest increasing subsequence. */
function lisIndices(seq: number[]): Set<number> {
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

export type SectionAlignment = { old: string; new: string; moved: string[] };

function alignLevel(oldText: string, newText: string, levelIdx: number, moved: string[]): { old: string; new: string } {
  if (levelIdx >= LEVELS.length) return { old: oldText, new: newText };
  const level = LEVELS[levelIdx];
  const os = splitBlocks(oldText, level);
  const ns = splitBlocks(newText, level);
  if (!os.blocks.length && !ns.blocks.length) return alignLevel(oldText, newText, levelIdx + 1, moved);
  if (!os.blocks.length || !ns.blocks.length) return { old: oldText, new: newText };

  const match = matchBlocks(os.blocks, ns.blocks);
  const matchedNew = [...match.keys()].sort((a, b) => a - b);
  const keep = lisIndices(matchedNew.map((ni) => match.get(ni)!));
  const movedNew = new Set(matchedNew.filter((_, k) => !keep.has(k)));

  const note = `\n\\${SECTION_MOVED_CMD}\n`;
  const piece = (text: string, b: Block) => ({ heading: text.slice(b.start, b.headEnd), body: text.slice(b.headEnd, b.end) });

  const newParts: string[] = [ns.head];
  const oldOut = new Map<number, string>();
  ns.blocks.forEach((nb, ni) => {
    const np = piece(newText, nb);
    const oi = match.get(ni);
    if (oi === undefined) {
      newParts.push(np.heading + np.body);
      return;
    }
    const op = piece(oldText, os.blocks[oi]);
    const inner = alignLevel(op.body, np.body, levelIdx + 1, moved);
    const n = movedNew.has(ni) ? note : "";
    if (n) moved.push(nb.title.trim() || nb.label || level);
    newParts.push(np.heading + n + inner.new);
    oldOut.set(oi, op.heading + n + inner.old);
  });
  newParts.push(ns.tail);

  // Unmatched old blocks travel with the nearest preceding matched old block.
  const follow = new Map<number, number[]>();
  const front: number[] = [];
  let lastMatched = -1;
  os.blocks.forEach((_, oi) => {
    if (oldOut.has(oi)) {
      lastMatched = oi;
      return;
    }
    if (lastMatched < 0) front.push(oi);
    else follow.set(lastMatched, [...(follow.get(lastMatched) ?? []), oi]);
  });
  const raw = (oi: number) => oldText.slice(os.blocks[oi].start, os.blocks[oi].end);
  const oldParts: string[] = [os.head, ...front.map(raw)];
  ns.blocks.forEach((_, ni) => {
    const oi = match.get(ni);
    if (oi === undefined) return;
    oldParts.push(oldOut.get(oi)!);
    for (const f of follow.get(oi) ?? []) oldParts.push(raw(f));
  });
  oldParts.push(os.tail);
  return { old: oldParts.join(""), new: newParts.join("") };
}

/** Rearrange the old document body into the new section order before latexdiff. */
export function alignMovedSections(oldTex: string, newTex: string): SectionAlignment {
  const bodyAt = (t: string) => {
    const m = /\\begin\s*\{document\}/.exec(maskComments(t));
    return m ? m.index + m[0].length : 0;
  };
  const ob = bodyAt(oldTex);
  const nb = bodyAt(newTex);
  const moved: string[] = [];
  const r = alignLevel(oldTex.slice(ob), newTex.slice(nb), 0, moved);
  return { old: oldTex.slice(0, ob) + r.old, new: newTex.slice(0, nb) + r.new, moved };
}
