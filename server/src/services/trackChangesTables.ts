/**
 * Move-aware, cell-level table markup for latexdiff track changes.
 *
 * latexdiff cannot mark tabular cells without breaking compilation, and it
 * cannot follow a table that moved. So each table "unit" (the tabular plus a
 * wrapper that holds its caption) is lifted out of both flattened sources and
 * replaced by an identical placeholder before latexdiff runs. Old/new units
 * are paired by \label, caption, or content; the caption wrapper is diffed by
 * latexdiff on its own, and the tabular body is diffed row-by-row and
 * cell-by-cell here. The marked unit is spliced back where the placeholder
 * survives (uncommented) in the latexdiff output, i.e. at the new position.
 */

export const TABLE_BLOCK_CMD = "OpenLeafTableBlock";
export const TABULAR_SLOT_CMD = "OpenLeafTabularSlot";

const TABULAR_ARGS: Record<string, number> = {
  tabular: 1,
  "tabular*": 2,
  tabularx: 2,
  tabulary: 2,
  longtable: 1,
  xltabular: 2,
};

const UNIT_WRAPPERS = new Set([
  "table",
  "table*",
  "sidewaystable",
  "sidewaystable*",
  "center",
  "minipage",
  "threeparttable",
  "threeparttablex",
  "adjustbox",
  "landscape",
  "small",
  "footnotesize",
  "scriptsize",
  "tiny",
  "flushleft",
  "flushright",
]);

const VERBATIM_ENVS = new Set(["verbatim", "verbatim*", "lstlisting", "minted", "comment", "Verbatim"]);

export const CELL_MARKUP_PREAMBLE = [
  "%DIF OPENLEAF CELL MARKUP",
  "\\providecommand{\\OpenLeafCellAdd}[1]{{\\protect\\color{blue}#1}}",
  "\\providecommand{\\OpenLeafCellDel}[1]{{\\protect\\color{red}#1}}",
  "\\providecommand{\\OpenLeafTableMoved}{\\par\\noindent{\\protect\\color{blue}\\small\\itshape Table moved.}\\par}",
  "\\providecommand{\\OpenLeafTableChanged}{\\par\\noindent{\\protect\\color{blue}\\small\\itshape Table changed.}\\par}",
  "",
].join("\n");

function isEscaped(s: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) n += 1;
  return n % 2 === 1;
}

/** Same length as `tex`, with every comment (unescaped % to end of line) blanked. */
export function maskComments(tex: string): string {
  const out = tex.split("");
  for (let i = 0; i < tex.length; i++) {
    if (tex[i] === "%" && !isEscaped(tex, i)) {
      while (i < tex.length && tex[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
    }
  }
  return out.join("");
}

/** Remove comments with TeX semantics: `%` eats the rest of the line and the next line's indent. */
function stripComments(tex: string): string {
  let out = "";
  for (let i = 0; i < tex.length; i++) {
    if (tex[i] === "%" && !isEscaped(tex, i)) {
      while (i < tex.length && tex[i] !== "\n") i += 1;
      i += 1;
      while (i < tex.length && (tex[i] === " " || tex[i] === "\t")) i += 1;
      i -= 1;
      continue;
    }
    out += tex[i];
  }
  return out;
}

/** Index just past the group that opens at `open` (`{`, `[` or `(`), or -1. */
export function groupEnd(s: string, open: number): number {
  const o = s[open];
  const c = o === "{" ? "}" : o === "[" ? "]" : o === "(" ? ")" : "";
  if (!c) return -1;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (o !== "{" && (ch === "{" || ch === "}")) {
      // Brackets may contain braced groups; skip them whole.
      if (ch === "{") {
        const e = groupEnd(s, i);
        if (e < 0) return -1;
        i = e - 1;
        continue;
      }
      return -1;
    }
    if (ch === o) depth += 1;
    else if (ch === c) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

export function skipSpace(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i += 1;
  return i;
}

type EnvSpan = {
  name: string;
  start: number;
  /** Just past `\begin{name}` */
  openEnd: number;
  /** Index of `\end{name}` */
  closeStart: number;
  end: number;
  parent: number;
};

function scanEnvs(masked: string): EnvSpan[] {
  const out: EnvSpan[] = [];
  const stack: number[] = [];
  const re = /\\(begin|end)\s*\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    if (isEscaped(masked, m.index)) continue;
    const name = m[2].trim();
    if (m[1] === "begin") {
      out.push({
        name,
        start: m.index,
        openEnd: m.index + m[0].length,
        closeStart: -1,
        end: -1,
        parent: stack.length ? stack[stack.length - 1] : -1,
      });
      stack.push(out.length - 1);
      if (VERBATIM_ENVS.has(name)) {
        const close = masked.indexOf(`\\end{${name}}`, re.lastIndex);
        if (close < 0) break;
        re.lastIndex = close;
      }
      continue;
    }
    let k = stack.length - 1;
    while (k >= 0 && out[stack[k]].name !== name) k -= 1;
    if (k < 0) continue;
    while (stack.length > k + 1) stack.pop();
    const idx = stack.pop()!;
    out[idx].closeStart = m.index;
    out[idx].end = m.index + m[0].length;
  }
  return out.filter((e) => e.end > 0);
}

export type TableUnit = {
  start: number;
  end: number;
  text: string;
  /** Tabular env range relative to `text`. */
  tabStart: number;
  tabEnd: number;
  label: string | null;
  caption: string | null;
  tokens: Set<string>;
};

function captionText(text: string): string | null {
  const m = /\\caption(?:of\s*\{[^}]*\})?\*?\s*(?:\[[^\]]*\])?\s*\{/.exec(text);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const end = groupEnd(text, open);
  if (end < 0) return null;
  return text.slice(open + 1, end - 1);
}

export function wordSet(s: string): Set<string> {
  const words = s
    .replace(/\\[A-Za-z@]+\*?/g, " ")
    .replace(/[{}$&\\[\]%~^_]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return new Set(words);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Top-level tabular units in the document body, widened to a single-table caption wrapper. */
export function findTableUnits(tex: string): TableUnit[] {
  const masked = maskComments(tex);
  const docBegin = masked.search(/\\begin\s*\{document\}/);
  const envs = scanEnvs(masked);
  const isTab = (e: EnvSpan) => e.name in TABULAR_ARGS;
  const hasTabAncestor = (i: number): boolean => {
    for (let p = envs[i].parent; p >= 0; p = envs[p].parent) if (isTab(envs[p])) return true;
    return false;
  };
  const tabIdx = envs
    .map((e, i) => i)
    .filter((i) => isTab(envs[i]) && !hasTabAncestor(i) && envs[i].start > docBegin);

  const tabCount = (p: number): number =>
    tabIdx.filter((t) => envs[t].start >= envs[p].start && envs[t].end <= envs[p].end).length;

  const units: TableUnit[] = [];
  for (const t of tabIdx) {
    let u = t;
    for (let p = envs[u].parent; p >= 0; p = envs[p].parent) {
      if (!UNIT_WRAPPERS.has(envs[p].name) || tabCount(p) !== 1) break;
      u = p;
    }
    const start = envs[u].start;
    const end = envs[u].end;
    const text = tex.slice(start, end);
    const maskedText = masked.slice(start, end);
    const label = /\\label\s*\{([^}]+)\}/.exec(maskedText)?.[1].trim() ?? null;
    const caption = captionText(maskedText);
    units.push({
      start,
      end,
      text,
      tabStart: envs[t].start - start,
      tabEnd: envs[t].end - start,
      label,
      caption,
      tokens: wordSet(stripComments(text.slice(envs[t].start - start, envs[t].end - start))),
    });
  }
  return units;
}

export type TablePair = { old: TableUnit | null; new: TableUnit };

/** Pair new units with old ones: \label first, then caption or content similarity. */
export function matchTableUnits(oldUnits: TableUnit[], newUnits: TableUnit[]): TablePair[] {
  const used = new Set<number>();
  const match = new Map<number, number>();
  newUnits.forEach((n, ni) => {
    if (!n.label) return;
    const oi = oldUnits.findIndex((o, i) => !used.has(i) && o.label === n.label);
    if (oi >= 0) {
      used.add(oi);
      match.set(ni, oi);
    }
  });
  const cands: { ni: number; oi: number; s: number }[] = [];
  newUnits.forEach((n, ni) => {
    if (match.has(ni)) return;
    oldUnits.forEach((o, oi) => {
      if (used.has(oi)) return;
      const cap = n.caption && o.caption ? jaccard(wordSet(n.caption), wordSet(o.caption)) : 0;
      const s = Math.max(cap, jaccard(n.tokens, o.tokens));
      if (s >= 0.5) cands.push({ ni, oi, s });
    });
  });
  cands.sort((a, b) => b.s - a.s);
  for (const c of cands) {
    if (match.has(c.ni) || used.has(c.oi)) continue;
    match.set(c.ni, c.oi);
    used.add(c.oi);
  }
  return newUnits.map((n, ni) => ({ old: match.has(ni) ? oldUnits[match.get(ni)!] : null, new: n }));
}

function replaceRanges(tex: string, ranges: { start: number; end: number; text: string }[]): string {
  let out = tex;
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, r.start) + r.text + out.slice(r.end);
  }
  return out;
}

export type PreparedTables = {
  old: string;
  new: string;
  blocks: Map<number, TablePair>;
};

/**
 * Replace each new table unit (and its matched old unit) with an identical
 * placeholder. Unmatched old units stay in place for latexdiff to delete.
 */
export function prepareTableBlocks(oldTex: string, newTex: string): PreparedTables {
  const oldUnits = findTableUnits(oldTex);
  const newUnits = findTableUnits(newTex);
  const pairs = matchTableUnits(oldUnits, newUnits);
  const blocks = new Map<number, TablePair>();
  const oldRanges: { start: number; end: number; text: string }[] = [];
  const newRanges: { start: number; end: number; text: string }[] = [];
  pairs.forEach((p, i) => {
    const k = i + 1;
    const ph = `\\${TABLE_BLOCK_CMD}{${k}}`;
    blocks.set(k, p);
    newRanges.push({ start: p.new.start, end: p.new.end, text: ph });
    if (p.old) oldRanges.push({ start: p.old.start, end: p.old.end, text: ph });
  });
  return { old: replaceRanges(oldTex, oldRanges), new: replaceRanges(newTex, newRanges), blocks };
}

/* ------------------------------------------------------------------ */
/* Tabular parsing                                                     */
/* ------------------------------------------------------------------ */

type Row = {
  prefix: string;
  /** null for rule/structure-only rows */
  cells: string[] | null;
  sep: string;
};

type ParsedTabular = { head: string; rows: Row[]; tail: string };

const RULE_SPECS: Record<string, string> = {
  hline: "",
  toprule: "[",
  midrule: "[",
  bottomrule: "[",
  cmidrule: "([{",
  cline: "{",
  addlinespace: "[",
  endfirsthead: "",
  endhead: "",
  endfoot: "",
  endlastfoot: "",
  noalign: "{",
  rowcolor: "[{",
  specialrule: "{{{",
  hhline: "{",
  pagebreak: "[",
  nopagebreak: "[",
  newpage: "",
};

/** Consume leading rule commands. `[`/`(` are optional args, `{` mandatory. */
function splitRulePrefix(row: string): { prefix: string; rest: string } {
  let i = 0;
  for (;;) {
    const j = skipSpace(row, i);
    const m = /^\\([A-Za-z]+)(?![A-Za-z])/.exec(row.slice(j));
    if (!m || !(m[1] in RULE_SPECS)) break;
    let k = j + m[0].length;
    let ok = true;
    for (const want of RULE_SPECS[m[1]]) {
      const at = skipSpace(row, k);
      if (row[at] !== want) {
        if (want === "{") ok = false;
        continue;
      }
      const e = groupEnd(row, at);
      if (e < 0) {
        ok = false;
        break;
      }
      k = e;
    }
    if (!ok) break;
    i = k;
  }
  return { prefix: row.slice(0, i), rest: row.slice(i) };
}

/** Split at top-level `sep` chars/strings, ignoring braces, nested envs and escapes. */
function splitTopLevel(s: string, isSep: (s: string, i: number) => number): { parts: string[]; seps: string[] } {
  const parts: string[] = [];
  const seps: string[] = [];
  let depth = 0;
  let env = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      if (s.startsWith("\\begin", i) && !/[A-Za-z]/.test(s[i + 6] ?? "")) env += 1;
      else if (s.startsWith("\\end", i) && !/[A-Za-z]/.test(s[i + 4] ?? "")) env -= 1;
      if (depth === 0 && env === 0) {
        const n = isSep(s, i);
        if (n > 0) {
          parts.push(s.slice(last, i));
          seps.push(s.slice(i, i + n));
          i += n - 1;
          last = i + 1;
          continue;
        }
      }
      i += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (depth === 0 && env === 0) {
      const n = isSep(s, i);
      if (n > 0) {
        parts.push(s.slice(last, i));
        seps.push(s.slice(i, i + n));
        i += n - 1;
        last = i + 1;
      }
    }
  }
  parts.push(s.slice(last));
  return { parts, seps };
}

function rowSepLength(s: string, i: number): number {
  let n = 0;
  if (s.startsWith("\\\\", i)) n = 2;
  else if (/^\\tabularnewline(?![A-Za-z])/.test(s.slice(i, i + 16))) n = "\\tabularnewline".length;
  else return 0;
  if (s[i + n] === "*") n += 1;
  const at = skipSpace(s, i + n);
  if (s[at] === "[") {
    const e = groupEnd(s, at);
    if (e > 0) n = e - i;
  }
  return n;
}

function cellSepLength(s: string, i: number): number {
  return s[i] === "&" ? 1 : 0;
}

function parseTabular(text: string): ParsedTabular | null {
  const m = /^\\begin\s*\{([^}]+)\}/.exec(text);
  if (!m) return null;
  const env = m[1].trim();
  const need = TABULAR_ARGS[env];
  if (need === undefined) return null;
  let i = m[0].length;
  let got = 0;
  while (got < need) {
    const at = skipSpace(text, i);
    if (text[at] !== "[" && text[at] !== "{") return null;
    const e = groupEnd(text, at);
    if (e < 0) return null;
    if (text[at] === "{") got += 1;
    i = e;
  }
  const close = text.lastIndexOf("\\end");
  if (close < i) return null;
  const head = text.slice(0, i);
  const tail = text.slice(close);
  const body = stripComments(text.slice(i, close));
  const { parts, seps } = splitTopLevel(body, rowSepLength);
  const rows: Row[] = parts.map((p, idx) => {
    const split = splitRulePrefix(p);
    const lead = split.rest.match(/^\s*/)![0];
    const prefix = split.prefix + lead;
    const rest = split.rest.slice(lead.length);
    const sep = seps[idx] ?? "";
    if (!rest.trim()) return { prefix: prefix + rest, cells: null, sep };
    return { prefix, cells: splitTopLevel(rest, cellSepLength).parts, sep };
  });
  return { head, rows, tail };
}

/* ------------------------------------------------------------------ */
/* Token / cell diff                                                   */
/* ------------------------------------------------------------------ */

type Tok = { text: string; kind: "word" | "par" | "barrier" };

const BARRIER_RE =
  /\\(?:begin|end|item|par|newline|tabularnewline|label|caption|captionof|footnote|hypertarget)(?![A-Za-z])|\\\\/;

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const ws = i;
    while (i < s.length && /\s/.test(s[i])) i += 1;
    if (i >= s.length) break;
    if (out.length && /\n[ \t]*\n/.test(s.slice(ws, i))) out.push({ text: "\n\n", kind: "par" });
    const start = i;
    let depth = 0;
    let math = false;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\\") {
        i += 1;
        if (/[A-Za-z@]/.test(s[i] ?? "")) while (i < s.length && /[A-Za-z@]/.test(s[i])) i += 1;
        else i += 1;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") depth = Math.max(0, depth - 1);
      else if (ch === "$") math = !math;
      else if (/\s/.test(ch) && depth === 0 && !math) break;
      i += 1;
    }
    const text = s.slice(start, i);
    out.push({ text, kind: BARRIER_RE.test(topLevelOnly(text)) ? "barrier" : "word" });
  }
  return out;
}

/** Brace groups emptied, so `\shortstack{a\\b}` is not mistaken for a row break. */
function topLevelOnly(s: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && depth === 0) {
      out += s.slice(i, i + 2);
      i += 1;
      continue;
    }
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) out += ch;
      depth += 1;
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) out += ch;
    } else if (depth === 0) out += ch;
  }
  return out;
}

type Op<T> = { op: "eq" | "del" | "add"; a?: T; b?: T };

const LCS_CAP = 4_000_000;

function diffSeq<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): Op<T>[] | null {
  const n = a.length;
  const m = b.length;
  if (n * m > LCS_CAP) return null;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = eq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(a[i], b[j])) {
      ops.push({ op: "eq", a: a[i], b: b[j] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ op: "del", a: a[i++] });
    else ops.push({ op: "add", b: b[j++] });
  }
  while (i < n) ops.push({ op: "del", a: a[i++] });
  while (j < m) ops.push({ op: "add", b: b[j++] });
  return ops;
}

/** Plain enough for latexdiff's ulem-based \DIFadd / \DIFdel. */
function ulemSafe(s: string): boolean {
  return !/[&#]|\\\\|\\(?:shortstack|multicolumn|multirow|makecell|parbox|verb|cite\w*|ref|eqref|footnote|url|href|hyperlink|vspace|hspace|raggedright|centering|strut|color|textcolor)(?![A-Za-z])/.test(
    s,
  );
}

function wrapRun(toks: Tok[], kind: "add" | "del"): string {
  const pieces: string[] = [];
  let words: string[] = [];
  const flush = () => {
    if (!words.length) return;
    const text = words.join(" ");
    if (kind === "add") pieces.push(ulemSafe(text) ? `\\DIFadd{${text}}` : `\\OpenLeafCellAdd{${text}}`);
    else pieces.push(ulemSafe(text) ? `\\DIFdel{${text}}` : `\\OpenLeafCellDel{${text}}`);
    words = [];
  };
  for (const t of toks) {
    if (t.kind === "word") {
      words.push(t.text);
      continue;
    }
    flush();
    // Structure follows the new side: emit added barriers raw, drop deleted ones.
    if (kind === "add") pieces.push(t.text);
  }
  flush();
  return pieces.join(" ");
}

export function diffText(oldText: string, newText: string): string {
  if (oldText.trim() === newText.trim()) return newText;
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const ops = diffSeq(a, b, (x, y) => x.kind === y.kind && x.text === y.text);
  if (!ops) return `${wrapRun(a, "del")} ${wrapRun(b, "add")}`.trim();
  const out: string[] = [];
  let dels: Tok[] = [];
  let adds: Tok[] = [];
  const flush = () => {
    if (dels.length) out.push(wrapRun(dels, "del"));
    if (adds.length) out.push(wrapRun(adds, "add"));
    dels = [];
    adds = [];
  };
  for (const o of ops) {
    if (o.op === "eq") {
      flush();
      out.push(o.b!.text);
    } else if (o.op === "del") dels.push(o.a!);
    else adds.push(o.b!);
  }
  flush();
  return out
    .filter((s) => s !== "")
    .join(" ")
    .replace(/ ?\n\n ?/g, "\n\n");
}

/** `\multicolumn{n}{spec}{body}` / `\caption{body}` etc.: split into wrapper and body. */
function splitCellWrapper(cell: string): { open: string; body: string; close: string } | null {
  const lead = cell.match(/^\s*/)![0];
  const t = cell.slice(lead.length);
  const m = /^\\(multicolumn|multirow|caption\*?|makecell)(?![A-Za-z])/.exec(t);
  if (!m) return null;
  const mandatory = m[1] === "multicolumn" || m[1] === "multirow" ? 3 : 1;
  let i = m[0].length;
  let got = 0;
  let bodyOpen = -1;
  let bodyEnd = -1;
  while (got < mandatory) {
    const at = skipSpace(t, i);
    if (t[at] !== "[" && t[at] !== "{") return null;
    const e = groupEnd(t, at);
    if (e < 0) return null;
    if (t[at] === "{") {
      got += 1;
      bodyOpen = at;
      bodyEnd = e;
    }
    i = e;
  }
  return {
    open: lead + t.slice(0, bodyOpen + 1),
    body: t.slice(bodyOpen + 1, bodyEnd - 1),
    close: t.slice(bodyEnd - 1),
  };
}

function diffCell(oldCell: string, newCell: string): string {
  if (oldCell.trim() === newCell.trim()) return newCell;
  const nw = splitCellWrapper(newCell);
  const ow = splitCellWrapper(oldCell);
  if (nw) return `${nw.open}${diffText(ow ? ow.body : oldCell, nw.body)}${nw.close}`;
  if (ow && !newCell.trim()) return ` ${wrapCell(oldCell, "del")} `;
  return ` ${diffText(ow ? ow.body : oldCell, newCell)} `;
}

function wrapCell(cell: string, kind: "add" | "del"): string {
  if (!cell.trim()) return cell;
  const w = splitCellWrapper(cell);
  const toks = tokenize(w ? w.body : cell);
  const inner = wrapRun(toks, kind);
  // A deleted \caption must not emit a second caption (it would bump the table counter).
  if (w && (kind === "add" || !/^\s*\\caption/.test(w.open))) return `${w.open}${inner}${w.close}`;
  return ` ${inner} `;
}

function normCell(c: string): string {
  return c.replace(/\s+/g, " ").trim();
}

function rowKey(r: Row): string {
  return r.cells ? r.cells.map(normCell).join(" & ") : `\u0000${normCell(r.prefix)}`;
}

function rowSim(a: Row, b: Row): number {
  if (!a.cells || !b.cells) return 0;
  const lead = (r: Row) => /^\s*\\(caption\*?)(?![A-Za-z])/.exec(r.cells![0] ?? "")?.[1];
  if (lead(a) && lead(a) === lead(b)) return 1;
  const fa = normCell(a.cells[0] ?? "");
  if (fa && fa === normCell(b.cells[0] ?? "") && a.cells.length === b.cells.length) return 1;
  const n = Math.max(a.cells.length, b.cells.length);
  let same = 0;
  for (let i = 0; i < n; i++) if (normCell(a.cells[i] ?? "") === normCell(b.cells[i] ?? "")) same += 1;
  return same / n;
}

function cellCount(rows: Row[]): number {
  return rows.reduce((mx, r) => Math.max(mx, r.cells?.length ?? 0), 0);
}

function renderRow(r: Row, cells: string[]): string {
  return `${r.prefix}${cells.join("&")}${r.sep}`;
}

function deletedRow(r: Row): string {
  if (!r.cells) return "";
  const sep = r.sep || "\\\\";
  return `\n${r.cells.map((c) => wrapCell(c, "del").trim()).join(" & ")}${sep}`;
}

function addedRow(r: Row): string {
  if (!r.cells) return `${r.prefix}${r.sep}`;
  return renderRow(r, r.cells.map((c) => wrapCell(c, "add")));
}

function pairedRow(o: Row, n: Row): string {
  const cells = n.cells!.map((c, i) => diffCell(o.cells![i] ?? "", c));
  return renderRow(n, cells);
}

/**
 * Cell-level markup for one tabular. `oldText` null means the table is new.
 * Returns null when the column layout changed and cells cannot be aligned.
 */
export function diffTabular(oldText: string | null, newText: string): string | null {
  const nt = parseTabular(newText);
  if (!nt) return null;
  if (oldText === null) {
    return `${nt.head}${nt.rows.map(addedRow).join("")}${nt.tail}`;
  }
  const ot = parseTabular(oldText);
  if (!ot) return null;
  if (cellCount(ot.rows) !== cellCount(nt.rows)) return null;
  const ops = diffSeq(ot.rows, nt.rows, (x, y) => rowKey(x) === rowKey(y));
  if (!ops) return null;

  const out: string[] = [];
  let dels: Row[] = [];
  let adds: Row[] = [];
  const flush = () => {
    const hits: number[] = [];
    let from = 0;
    for (const a of adds) {
      let hit = -1;
      for (let k = from; k < dels.length; k++) {
        if (rowSim(dels[k], a) >= 0.5) {
          hit = k;
          break;
        }
      }
      hits.push(hit);
      if (hit >= 0) from = hit + 1;
    }
    let j = 0;
    adds.forEach((a, i) => {
      const hit = hits[i];
      // Deleted rows print before the added rows that follow them.
      const upto = hit >= 0 ? hit : (hits.slice(i + 1).find((h) => h >= 0) ?? dels.length);
      for (; j < upto; j++) out.push(deletedRow(dels[j]));
      if (hit < 0) {
        out.push(addedRow(a));
        return;
      }
      const d = dels[hit];
      out.push(d.cells!.length === a.cells!.length ? pairedRow(d, a) : deletedRow(d) + addedRow(a));
      j = hit + 1;
    });
    for (; j < dels.length; j++) out.push(deletedRow(dels[j]));
    dels = [];
    adds = [];
  };
  for (const o of ops) {
    if (o.op === "eq") {
      flush();
      out.push(renderRow(o.b!, o.b!.cells ?? []));
    } else if (o.op === "del") dels.push(o.a!);
    else adds.push(o.b!);
  }
  flush();
  return `${nt.head}${out.join("")}${nt.tail}`;
}

/* ------------------------------------------------------------------ */
/* Unit markup and splice                                              */
/* ------------------------------------------------------------------ */

export type MiniLatexdiff = (oldBody: string, newBody: string) => Promise<string>;

export type TableBlockStats = { cellLevel: number; atomic: number; added: number; moved: number };

function slotted(u: TableUnit): string {
  return `${u.text.slice(0, u.tabStart)}\\${TABULAR_SLOT_CMD}{1}${u.text.slice(u.tabEnd)}`;
}

async function markUnit(
  pair: TablePair,
  latexdiffBody: MiniLatexdiff,
  stats: TableBlockStats,
): Promise<string> {
  const n = pair.new;
  const o = pair.old;
  if (o && o.text === n.text) return n.text;
  const newTab = n.text.slice(n.tabStart, n.tabEnd);
  const oldTab = o ? o.text.slice(o.tabStart, o.tabEnd) : null;
  let tab = diffTabular(oldTab, newTab);
  if (tab === null) {
    stats.atomic += 1;
    tab = `\\OpenLeafTableChanged ${newTab}`;
  } else if (o) stats.cellLevel += 1;
  else stats.added += 1;

  const wrapperNew = slotted(n);
  const wrapperOld = o ? slotted(o) : "";
  let wrapper = wrapperNew;
  if (wrapperOld !== wrapperNew && wrapperNew.trim() !== `\\${TABULAR_SLOT_CMD}{1}`) {
    wrapper = await latexdiffBody(wrapperOld, wrapperNew);
  }
  const slot = `\\${TABULAR_SLOT_CMD}{1}`;
  let at = uncommentedIndexOf(wrapper, slot)[0];
  if (at === undefined) {
    wrapper = wrapperNew;
    at = wrapper.indexOf(slot);
  }
  return wrapper.slice(0, at) + tab + wrapper.slice(at + slot.length);
}

function uncommentedIndexOf(tex: string, needle: string): number[] {
  const masked = maskComments(tex);
  const hits: number[] = [];
  for (let i = masked.indexOf(needle); i >= 0; i = masked.indexOf(needle, i + needle.length)) {
    hits.push(i);
  }
  return hits;
}

/** Swap surviving placeholders in latexdiff output for the marked tables. */
export async function renderTableBlocks(
  marked: string,
  blocks: Map<number, TablePair>,
  latexdiffBody: MiniLatexdiff,
): Promise<{ tex: string; stats: TableBlockStats }> {
  const stats: TableBlockStats = { cellLevel: 0, atomic: 0, added: 0, moved: 0 };
  let tex = marked;
  for (const [k, pair] of [...blocks.entries()].sort((a, b) => b[0] - a[0])) {
    const ph = `\\${TABLE_BLOCK_CMD}{${k}}`;
    const hits = uncommentedIndexOf(tex, ph);
    if (!hits.length) continue;
    const deletedAtOldSpot = pair.old && tex.includes(`%DIFDELCMD < ${ph}`);
    if (deletedAtOldSpot) stats.moved += 1;
    const body = await markUnit(pair, latexdiffBody, stats);
    const note = deletedAtOldSpot ? "\\OpenLeafTableMoved\n" : "";
    for (const at of hits.reverse()) {
      tex = tex.slice(0, at) + note + body + tex.slice(at + ph.length);
    }
  }
  if (!tex.includes("%DIF OPENLEAF CELL MARKUP")) {
    const begin = tex.indexOf("\\begin{document}");
    tex = begin < 0 ? CELL_MARKUP_PREAMBLE + tex : tex.slice(0, begin) + CELL_MARKUP_PREAMBLE + tex.slice(begin);
  }
  return { tex, stats };
}

const HEADING_RE = /^\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*[[{]/;

/**
 * Pandoc wraps headings as `\hypertarget{id}{%\n\section{...}\label{...}}`.
 * latexdiff treats the wrapper as one opaque command, so heading edits vanish.
 * Drop the wrapper (hyperref still anchors the section via its \label).
 */
export function unwrapHeadingTargets(tex: string): string {
  const masked = maskComments(tex);
  const ranges: { start: number; end: number; text: string }[] = [];
  const re = /\\hypertarget\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    if (isEscaped(masked, m.index)) continue;
    const idEnd = groupEnd(masked, m.index + m[0].length - 1);
    if (idEnd < 0) continue;
    const bodyOpen = skipSpace(masked, idEnd);
    if (masked[bodyOpen] !== "{") continue;
    const bodyEnd = groupEnd(masked, bodyOpen);
    if (bodyEnd < 0) continue;
    const inner = tex.slice(bodyOpen + 1, bodyEnd - 1);
    const lead = /^(?:\s|%[^\n]*\n)*/.exec(inner)![0];
    const heading = inner.slice(lead.length);
    if (!HEADING_RE.test(heading)) continue;
    ranges.push({ start: m.index, end: bodyEnd, text: heading.replace(/\s+$/, "") });
    re.lastIndex = bodyEnd;
  }
  return replaceRanges(tex, ranges);
}
