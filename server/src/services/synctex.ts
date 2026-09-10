import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  pdfPathAbs,
  projectDir,
  readProjectConfig,
  synctexPathAbs,
} from "./projectFs.js";

export type SynctexReverseHit = {
  input: string;
  line: number;
  column: number;
};

export type SynctexForwardHit = {
  page: number;
  x: number;
  y: number;
  h: number;
  v: number;
  width: number;
  height: number;
};

export type SynctexBox = {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

function isProjectSource(input: string): boolean {
  if (!input) return false;
  if (input.includes("texmf")) return false;
  if (input.split("/").includes("..")) return false;
  if (input.startsWith(".openleaf/") || input.includes("/.openleaf/")) return false;
  if (input.startsWith(".paperflow/") || input.includes("/.paperflow/")) return false;
  return true;
}

/**
 * Map SyncTeX Input paths onto the current project tree.
 * Absolute paths from a previous checkout (e.g. PaperFlow → OpenLeaf) must not become
 * `../../../OtherRoot/projects/<id>/sections/foo.tex`.
 */
function normalizeRel(cwd: string, raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, "/");
  const projectName = path.basename(cwd);
  const absCandidate = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
  const absNorm = absCandidate.replace(/\\/g, "/");

  // Prefer: everything after the last /<projectId>/ segment (survives relocated checkouts).
  const marker = `/${projectName}/`;
  const markerIdx = absNorm.lastIndexOf(marker);
  if (markerIdx >= 0) {
    return absNorm
      .slice(markerIdx + marker.length)
      .replace(/\/\.\//g, "/")
      .replace(/^\.\//, "");
  }

  let rel = path.isAbsolute(trimmed) ? path.relative(cwd, trimmed) : trimmed;
  rel = rel
    .replace(/\\/g, "/")
    .replace(/\/\.\//g, "/")
    .replace(/^\.\//, "");

  // Last resort: drop leading ../ segments if the remainder looks like a project path.
  if (rel.split("/").includes("..")) {
    const parts = rel.split("/").filter((p) => p && p !== ".");
    while (parts[0] === "..") parts.shift();
    // Strip a duplicated project folder name if present
    if (parts[0] === projectName) parts.shift();
    rel = parts.join("/");
  }
  return rel;
}

function pathsMatch(a: string, b: string, loose = false): boolean {
  const na = a.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const nb = b.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  if (na === nb) return true;
  if (na.endsWith("/" + nb) || nb.endsWith("/" + na)) return true;
  if (loose && path.basename(na) === path.basename(nb)) return true;
  return false;
}

function nodeScore(
  n: { x: number; y: number; w: number; h: number },
  x: number,
  y: number,
): number {
  const w = Math.max(n.w, 4);
  const h = Math.max(n.h, 6);
  // Full-page boxes are noise from form reuse
  if (w > 400 && h > 80) return -1e9;
  if (h > 120) return -1e9;
  const inY = y >= n.y - h && y <= n.y + h * 1.8;
  const inX = x >= n.x - 8 && x <= n.x + w + 8;
  let score = 0;
  if (inY) score += 200;
  if (inX) score += 80;
  // Vertical distance dominates (line selection)
  score -= Math.abs(n.y - y) * 6;
  score -= Math.abs(n.x + w / 2 - x) * 0.12;
  // Prefer real line-ish boxes over glue/kern and over giant spans
  score += Math.min(w, 360) * 0.04;
  score += Math.min(h, 18) * 0.8;
  if (h > 40) score -= (h - 40) * 2;
  return score;
}

type SynctexNode = {
  tag: number;
  line: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** TeX depth below baseline (hbox only) */
  d: number;
  /** '(' hbox, 'x' current-point, 'h' horizontal */
  kind: string;
};

type ParsedSynctex = {
  inputs: Map<number, string>;
  /** page → nodes */
  pages: Map<number, SynctexNode[]>;
};

function parseSynctexFile(synctexGz: string, cwd: string): ParsedSynctex | null {
  try {
    const text = gunzipSync(fs.readFileSync(synctexGz)).toString("utf8");
    const inputs = new Map<number, string>();
    for (const m of text.matchAll(/^Input:(\d+):(.+)$/gm)) {
      inputs.set(Number(m[1]), normalizeRel(cwd, m[2]));
    }

    const pages = new Map<number, SynctexNode[]>();
    const sheetRe = /(?:^|\n)\{(\d+)(?:\n|$)/g;
    let sheetMatch: RegExpExecArray | null;
    while ((sheetMatch = sheetRe.exec(text))) {
      const page = Number(sheetMatch[1]);
      const start = sheetMatch.index + sheetMatch[0].length;
      const rest = text.slice(start);
      // pdfTeX closes a sheet with "}N" (N = page), not a bare "}".
      let endRel = rest.search(new RegExp(`\\n\\}${page}(?:\\n|$)`));
      if (endRel < 0) endRel = rest.search(/\n\}(?:\n|$)/);
      const slice = endRel >= 0 ? rest.slice(0, endRel) : rest.slice(0, 20_000);
      const nodes: SynctexNode[] = [];
      // '(' hbox, 'x' current-point, 'h' horizontal — all carry tag,line:x,y
      for (const m of slice.matchAll(
        /(?:^|\n)([xh(])([-\d]+),(\d+):([-\d]+),([-\d]+)(?::([-\d]+),([-\d]+)(?:,([-\d]+))?)?/g,
      )) {
        const kind = m[1]!;
        const tag = Number(m[2]);
        const line = Number(m[3]);
        const x = Number(m[4]) / 65536;
        const y = Number(m[5]) / 65536;
        const w = m[6] != null ? Number(m[6]) / 65536 : 12;
        const h = m[7] != null ? Number(m[7]) / 65536 : 10;
        const d = m[8] != null ? Number(m[8]) / 65536 : 0;
        if (!line || !inputs.has(tag)) continue;
        const input = inputs.get(tag)!;
        if (!isProjectSource(input)) continue;
        // Skip empty glue-like boxes; keep current-point (default w/h) and real hboxes
        if (m[6] != null && w <= 0 && h <= 0) continue;
        nodes.push({ tag, line, x, y, w, h, d, kind });
      }
      pages.set(page, nodes);
    }
    return { inputs, pages };
  } catch {
    return null;
  }
}

/**
 * Reverse SyncTeX: PDF page/coords → source file/line.
 * Coordinates are PDF points with origin at the TOP-LEFT (y increases downward),
 * matching SyncTeX records from pdfTeX.
 */
export async function reverseSynctex(
  id: string,
  page: number,
  x: number,
  y: number,
  rootDir?: string,
): Promise<SynctexReverseHit | null> {
  const cfg = await readProjectConfig(id);
  const cwd = rootDir ?? projectDir(id);
  const synctex = synctexPathAbs(id, cfg.mainFile, cwd);
  const pdf = pdfPathAbs(id, cfg.mainFile, cwd);
  if (!fs.existsSync(synctex) || !fs.existsSync(pdf)) return null;

  // Prefer the official synctex binary — far more accurate than our parser
  const cli = await trySynctexEditCli(cwd, pdf, page, x, y);
  if (cli) return cli;

  const parsed = parseSynctexFile(synctex, cwd);
  if (parsed) {
    const nodes = (parsed.pages.get(page) ?? []).filter((n) => n.line > 0 && (n.w > 0 || n.h > 0));
    if (nodes.length > 0) {
      nodes.sort((a, b) => nodeScore(b, x, y) - nodeScore(a, x, y));
      const best = nodes[0]!;
      const bestInput = parsed.inputs.get(best.tag);
      if (!bestInput || !isProjectSource(bestInput)) {
        for (const n of nodes.slice(0, 12)) {
          const inp = parsed.inputs.get(n.tag);
          if (inp && isProjectSource(inp)) {
            return { input: inp, line: n.line, column: 1 };
          }
        }
        return null;
      }
      // Vote on line only among near-ties from the SAME file as the best hit
      const topScore = nodeScore(best, x, y);
      const sameFile = nodes
        .filter((n) => parsed.inputs.get(n.tag) === bestInput)
        .filter((n) => nodeScore(n, x, y) >= topScore - 25)
        .slice(0, 20);
      const lineCounts = new Map<number, { n: number; score: number }>();
      for (const n of sameFile) {
        const sc = nodeScore(n, x, y);
        const prev = lineCounts.get(n.line);
        if (!prev) lineCounts.set(n.line, { n: 1, score: sc });
        else {
          prev.n += 1;
          prev.score = Math.max(prev.score, sc);
        }
      }
      const line = [...lineCounts.entries()].sort(
        (a, b) => b[1].n - a[1].n || b[1].score - a[1].score,
      )[0]![0];
      return { input: bestInput, line, column: 1 };
    }
  }

  return null;
}

/**
 * Forward SyncTeX: source file/line → PDF page/coords (top-left origin).
 */
export async function forwardSynctex(
  id: string,
  file: string,
  line: number,
  column = 1,
  rootDir?: string,
): Promise<SynctexForwardHit | null> {
  const cfg = await readProjectConfig(id);
  const cwd = rootDir ?? projectDir(id);
  const synctex = synctexPathAbs(id, cfg.mainFile, cwd);
  const pdf = pdfPathAbs(id, cfg.mainFile, cwd);
  if (!fs.existsSync(synctex) || !fs.existsSync(pdf)) return null;

  const cli = await trySynctexViewCli(cwd, pdf, file, line, column);
  if (cli) return cli;

  const parsed = parseSynctexFile(synctex, cwd);
  if (parsed) {
    const fileNorm = file.replace(/\\/g, "/").replace(/^\.\//, "");
    type Cand = { page: number; tag: number; line: number; x: number; y: number; w: number; h: number };
    const collect = (loose: boolean) => {
      const out: Cand[] = [];
      for (const [page, nodes] of parsed.pages) {
        for (const n of nodes) {
          if (n.line <= 0 || (n.w <= 0 && n.h <= 0)) continue;
          const input = parsed.inputs.get(n.tag);
          if (!input || !pathsMatch(input, fileNorm, loose)) continue;
          out.push({ page, ...n });
        }
      }
      return out;
    };
    let cands = collect(false);
    if (cands.length === 0) cands = collect(true);
    if (cands.length > 0) {
      const minDist = Math.min(...cands.map((c) => Math.abs(c.line - line)));
      const near = cands.filter((c) => Math.abs(c.line - line) === minDist);
      near.sort((a, b) => b.w - a.w || a.x - b.x);
      const page = near[0]!.page;
      const onPage = near.filter((c) => c.page === page);
      const xs = onPage.map((c) => c.x);
      const rights = onPage.map((c) => c.x + Math.max(c.w, 8));
      const ys = onPage.map((c) => c.y);
      const hs = onPage.map((c) => Math.max(c.h, 8));
      const x0 = Math.min(...xs);
      const x1 = Math.max(...rights);
      const yMid = ys.reduce((s, v) => s + v, 0) / ys.length;
      const hMax = Math.max(...hs);
      return {
        page,
        x: x0,
        y: yMid,
        h: hMax,
        v: yMid,
        width: Math.max(x1 - x0, 120),
        height: Math.max(hMax * 1.35, 14),
      };
    }
  }

  return null;
}

function rectContains(outer: SynctexBox, inner: SynctexBox, slop = 1.25): boolean {
  if (outer.page !== inner.page) return false;
  return (
    inner.x >= outer.x - slop &&
    inner.y >= outer.y - slop &&
    inner.x + inner.width <= outer.x + outer.width + slop &&
    inner.y + inner.height <= outer.y + outer.height + slop &&
    inner.width * inner.height < outer.width * outer.height - 4
  );
}

function dropContainedBoxes(boxes: SynctexBox[]): SynctexBox[] {
  return boxes.filter((a, i) => !boxes.some((b, j) => i !== j && rectContains(b, a)));
}

/**
 * Map many source file:line sets onto PDF boxes in one SyncTeX parse.
 * Uses real hboxes only: SyncTeX (x,y) is the baseline, height is above it, depth below.
 */
export async function boxesForFileLines(
  id: string,
  fileLines: Map<string, Set<number> | "all">,
  rootDir?: string,
): Promise<SynctexBox[]> {
  if (fileLines.size === 0) return [];
  const cfg = await readProjectConfig(id);
  const cwd = rootDir ?? projectDir(id);
  const synctex = synctexPathAbs(id, cfg.mainFile, cwd);
  const pdf = pdfPathAbs(id, cfg.mainFile, cwd);
  if (!fs.existsSync(synctex) || !fs.existsSync(pdf)) return [];

  const parsed = parseSynctexFile(synctex, cwd);
  if (!parsed) return [];

  const wanted = new Map<string, Set<number> | "all">();
  for (const [file, lines] of fileLines) {
    wanted.set(file.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase(), lines);
  }

  const specFor = (input: string): Set<number> | "all" | undefined => {
    const key = input.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    const direct = wanted.get(key);
    if (direct) return direct;
    for (const [file, spec] of wanted) {
      if (pathsMatch(input, file, false)) return spec;
    }
    return undefined;
  };

  const lineWanted = (input: string, line: number): boolean => {
    const spec = specFor(input);
    if (!spec) return false;
    if (spec === "all") return true;
    return spec.has(line) || spec.has(line - 1) || spec.has(line + 1);
  };

  const raw: Array<SynctexBox & { input: string; line: number; yq: number }> = [];
  for (const [page, nodes] of parsed.pages) {
    for (const n of nodes) {
      if (n.kind !== "(" || n.line <= 0) continue;
      const input = parsed.inputs.get(n.tag);
      if (!input || !lineWanted(input, n.line)) continue;
      const boxH = n.h + n.d;
      // One text line; skip glue, superscripts, and multi-line containers.
      if (n.w < 20 || boxH < 4 || boxH > 22) continue;
      const top = n.y - n.h;
      if (top < 32 || top > 730) continue;
      raw.push({
        page,
        x: n.x,
        y: Math.max(0, top - 0.6),
        width: n.w,
        height: boxH + 1.4,
        input,
        line: n.line,
        yq: Math.round(top),
      });
    }
  }

  return collapseOverlappingBoxes(dropContainedBoxes(dedupeBoxes(dropReusedFormBoxes(raw))));
}

/** Form XObject reuse copies the same hbox onto other pages — keep real shipouts, drop copies. */
function dropReusedFormBoxes(
  boxes: Array<SynctexBox & { input: string; line: number; yq: number }>,
): SynctexBox[] {
  const byLine = new Map<string, Array<SynctexBox & { input: string; line: number; yq: number }>>();
  for (const b of boxes) {
    const key = `${b.input}:${b.line}`;
    const list = byLine.get(key) ?? [];
    list.push(b);
    byLine.set(key, list);
  }

  const keep = new Set<SynctexBox & { input: string; line: number; yq: number }>();
  for (const group of byLine.values()) {
    const byPage = new Map<number, typeof group>();
    for (const b of group) {
      const list = byPage.get(b.page) ?? [];
      list.push(b);
      byPage.set(b.page, list);
    }
    const pages = [...byPage.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
    const keptSigs: number[][] = [];
    for (const [, list] of pages) {
      const sig = [...new Set(list.map((b) => b.yq))].sort((a, b) => a - b);
      const reused = keptSigs.some((prev) => ySignatureOverlap(prev, sig) > 0.55);
      if (reused) continue;
      keptSigs.push(sig);
      for (const b of list) keep.add(b);
    }
  }

  return [...keep].map(({ page, x, y, width, height }) => ({ page, x, y, width, height }));
}

function ySignatureOverlap(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const bs = new Set(b);
  let n = 0;
  for (const y of a) {
    if (bs.has(y) || bs.has(y - 1) || bs.has(y + 1)) n += 1;
  }
  return n / Math.min(a.length, b.length);
}

/** Two SyncTeX grids on one page (slightly offset) → one bar per visual line. */
function collapseOverlappingBoxes(boxes: SynctexBox[]): SynctexBox[] {
  const byPage = new Map<number, SynctexBox[]>();
  for (const b of boxes) {
    const list = byPage.get(b.page) ?? [];
    list.push(b);
    byPage.set(b.page, list);
  }
  const out: SynctexBox[] = [];
  for (const [page, list] of byPage) {
    const sorted = [...list].sort((a, b) => a.y - b.y || a.x - b.x);
    const merged: SynctexBox[] = [];
    for (const b of sorted) {
      const prev = merged[merged.length - 1];
      if (
        prev &&
        Math.abs(b.y - prev.y) < 5.5 &&
        !(b.x > prev.x + prev.width + 8 || prev.x > b.x + b.width + 8)
      ) {
        const x0 = Math.min(prev.x, b.x);
        const y0 = Math.min(prev.y, b.y);
        const x1 = Math.max(prev.x + prev.width, b.x + b.width);
        const y1 = Math.max(prev.y + prev.height, b.y + b.height);
        merged[merged.length - 1] = { page, x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      } else {
        merged.push({ ...b });
      }
    }
    out.push(...merged);
  }
  return out;
}

function dedupeBoxes(boxes: SynctexBox[]): SynctexBox[] {
  const seen = new Set<string>();
  return boxes.filter((b) => {
    const k = `${b.page}:${b.x.toFixed(1)}:${b.y.toFixed(1)}:${b.width.toFixed(1)}:${b.height.toFixed(1)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Reverse: PDF → source via `synctex edit` */
function trySynctexEditCli(
  cwd: string,
  pdf: string,
  page: number,
  x: number,
  y: number,
): Promise<SynctexReverseHit | null> {
  return new Promise((resolve) => {
    const outDir = path.dirname(pdf);
    const pdfName = path.basename(pdf);
    const child = spawn(
      "synctex",
      ["edit", "-o", `${page}:${x.toFixed(2)}:${y.toFixed(2)}:${pdfName}`],
      { cwd: outDir },
    );
    let out = "";
    child.stdout.on("data", (b) => {
      out += b.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0 && !out.includes("Input:")) {
        resolve(null);
        return;
      }
      const input = /Input:(.+)/.exec(out)?.[1]?.trim();
      const line = Number(/Line:(\d+)/.exec(out)?.[1] ?? 0);
      const columnRaw = Number(/Column:(-?\d+)/.exec(out)?.[1] ?? 0);
      if (!input || !line) {
        resolve(null);
        return;
      }
      const rel = normalizeRel(cwd, input);
      if (!isProjectSource(rel)) {
        resolve(null);
        return;
      }
      resolve({
        input: rel,
        line,
        column: columnRaw > 0 ? columnRaw : 1,
      });
    });
  });
}

/** Forward: source → PDF via `synctex view` */
function trySynctexViewCli(
  cwd: string,
  pdf: string,
  file: string,
  line: number,
  column: number,
): Promise<SynctexForwardHit | null> {
  return new Promise((resolve) => {
    const outDir = path.dirname(pdf);
    const pdfName = path.basename(pdf);
    // SyncTeX wants the path TeX saw (often ./file.tex relative to project)
    const abs = path.isAbsolute(file) ? file : path.join(cwd, file);
    const asTeXSaw = "./" + path.relative(cwd, abs).replace(/\\/g, "/");
    const attempts = [asTeXSaw, path.relative(cwd, abs).replace(/\\/g, "/"), abs];

    const tryOne = (idx: number) => {
      if (idx >= attempts.length) {
        resolve(null);
        return;
      }
      const inputPath = attempts[idx]!;
      const child = spawn(
        "synctex",
        ["view", "-i", `${line}:${Math.max(0, column)}:${inputPath}`, "-o", pdfName],
        { cwd: outDir },
      );
      let out = "";
      child.stdout.on("data", (b) => {
        out += b.toString("utf8");
      });
      child.on("error", () => resolve(null));
      child.on("close", () => {
        const page = Number(/Page:(\d+)/.exec(out)?.[1] ?? 0);
        const x = Number(/x:([-\d.]+)/.exec(out)?.[1] ?? 0);
        const y = Number(/y:([-\d.]+)/.exec(out)?.[1] ?? 0);
        const h = Number(/h:([-\d.]+)/.exec(out)?.[1] ?? 10);
        const v = Number(/v:([-\d.]+)/.exec(out)?.[1] ?? y);
        const width = Number(/W:([-\d.]+)/.exec(out)?.[1] ?? /width:([-\d.]+)/i.exec(out)?.[1] ?? 40);
        const height = Number(/H:([-\d.]+)/.exec(out)?.[1] ?? /height:([-\d.]+)/i.exec(out)?.[1] ?? 12);
        if (!page) {
          tryOne(idx + 1);
          return;
        }
        resolve({
          page,
          x,
          y,
          h,
          v,
          width: Math.max(width, 40),
          height: Math.max(height, 10),
        });
      });
    };
    tryOne(0);
  });
}
