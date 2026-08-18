import type * as Y from "yjs";

export type TextHunk = {
  start: number;
  oldEnd: number;
  inserted: string;
};

/** Smallest prefix/suffix replace that turns `from` into `to`. */
export function prefixSuffixHunk(from: string, to: string): TextHunk {
  if (from === to) return { start: 0, oldEnd: 0, inserted: "" };
  let start = 0;
  const minLen = Math.min(from.length, to.length);
  while (start < minLen && from.charCodeAt(start) === to.charCodeAt(start)) start += 1;
  let fromEnd = from.length;
  let toEnd = to.length;
  while (
    fromEnd > start &&
    toEnd > start &&
    from.charCodeAt(fromEnd - 1) === to.charCodeAt(toEnd - 1)
  ) {
    fromEnd -= 1;
    toEnd -= 1;
  }
  return { start, oldEnd: fromEnd, inserted: to.slice(start, toEnd) };
}

/**
 * Replace Y.Text contents with a prefix/suffix patch instead of delete-all/insert-all,
 * so concurrent CRDT edits outside the changed span can still merge.
 */
export function patchYText(ytext: Y.Text, newContent: string): void {
  const cur = ytext.toString();
  if (cur === newContent) return;
  const hunk = prefixSuffixHunk(cur, newContent);
  const deleteLen = hunk.oldEnd - hunk.start;
  if (deleteLen > 0) ytext.delete(hunk.start, deleteLen);
  if (hunk.inserted) ytext.insert(hunk.start, hunk.inserted);
}

/**
 * 3-way merge of string edits. Non-overlapping prefix/suffix hunks are both kept.
 * Overlapping hunks prefer `theirs` (disk / external writer).
 */
export function threeWayMerge(base: string, ours: string, theirs: string): string {
  if (ours === theirs) return ours;
  if (ours === base) return theirs;
  if (theirs === base) return ours;

  const oursHunk = prefixSuffixHunk(base, ours);
  const theirsHunk = prefixSuffixHunk(base, theirs);
  const disjoint = oursHunk.oldEnd <= theirsHunk.start || theirsHunk.oldEnd <= oursHunk.start;
  if (!disjoint) return theirs;

  const later = oursHunk.start >= theirsHunk.start ? oursHunk : theirsHunk;
  const earlier = later === oursHunk ? theirsHunk : oursHunk;
  const afterLater = base.slice(0, later.start) + later.inserted + base.slice(later.oldEnd);
  return afterLater.slice(0, earlier.start) + earlier.inserted + afterLater.slice(earlier.oldEnd);
}
