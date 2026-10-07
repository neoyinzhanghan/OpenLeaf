import { spawn } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { compileProjectAtRoot, texEnv, type CompileResult } from "./compiler.js";
import { getProject, pdfPathAbs, projectDir, readProjectConfig } from "./projectFs.js";
import { getProjectCommit, isGitEnabled, type GitCommitInfo } from "./projectGit.js";
import { ensureSnapshotRoot } from "./timeline.js";
import { alignMovedSections, SECTION_MOVED_PREAMBLE } from "./trackChangesSections.js";
import { prepareTableBlocks, renderTableBlocks, unwrapHeadingTargets } from "./trackChangesTables.js";

const HASH_RE = /^[0-9a-f]{7,40}$/i;
const LATEXDIFF_TIMEOUT_MS = 120_000;
const MARKER = ".openleaf-track-changes-ok";
/** Bump when marked-tex post-processing changes so old scratch PDFs are rebuilt. */
const MARKER_VERSION = "4";

/** Treat these as atomic replacements so cell-level latexdiff does not break compile. */
export const LATEXDIFF_PICTURE_ENV =
  "(?:picture|DIFnomarkup|tabular|tabularx|longtable)[\\w\\d*@]*";

const TABLE_ENV = String.raw`(?:tabular\*?|tabularx|longtable)`;
const TABLE_BEGIN = new RegExp(String.raw`\\begin\{${TABLE_ENV}\}`);
const TABLE_DEL_BEGIN = new RegExp(String.raw`DIFDELCMD < \\begin\{${TABLE_ENV}\}`);
const ADD_TABLE_RE = new RegExp(
  String.raw`(\\DIFaddbegin)(\s*)(?=\\begin\{${TABLE_ENV}\})`,
  "g",
);
const DEL_BLOCK_RE = /\\DIFdelbegin[\s\S]*?\\DIFdelend/g;

export type TableAnnotations = { changed: number; removed: number };

/** `snippet`'s first line is its marker; it is injected once before \begin{document}. */
function injectPreamble(tex: string, snippet: string): string {
  if (tex.includes(snippet.split("\n")[0])) return tex;
  const begin = tex.indexOf("\\begin{document}");
  if (begin < 0) return snippet + tex;
  return `${tex.slice(0, begin)}${snippet}${tex.slice(begin)}`;
}

/**
 * Cell-level table markup is disabled (PICTUREENV). latexdiff then comments
 * out the old table and prints the new one unmarked — so insert a visible note.
 */
export function annotateReplacedTables(tex: string): { tex: string; tables: TableAnnotations } {
  let changed = 0;
  let marked = tex.replace(ADD_TABLE_RE, (_m, begin: string, space: string) => {
    changed += 1;
    return `${begin}${space}\\OpenLeafTableChanged `;
  });

  let removed = 0;
  marked = marked.replace(DEL_BLOCK_RE, (block, offset: number, whole: string) => {
    if (!TABLE_DEL_BEGIN.test(block)) return block;
    const after = whole.slice(offset + block.length);
    if (/^\s*\\DIFaddbegin/.test(after) && TABLE_BEGIN.test(after.slice(0, 400))) {
      return block;
    }
    removed += 1;
    return `${block}\\OpenLeafTableRemoved `;
  });

  if (changed + removed > 0) {
    const macros: string[] = ["%DIF OPENLEAF TABLE NOTES"];
    if (changed) {
      macros.push(
        "\\providecommand{\\OpenLeafTableChanged}{\\par\\noindent{\\protect\\color{blue}\\small\\itshape Table changed.}\\par}",
      );
    }
    if (removed) {
      macros.push(
        "\\providecommand{\\OpenLeafTableRemoved}{\\par\\noindent{\\protect\\color{red}\\small\\itshape Table removed.}\\par}",
      );
    }
    marked = injectPreamble(marked, `${macros.join("\n")}\n`);
  }
  return { tex: marked, tables: { changed, removed } };
}

export type TrackChangesResult = CompileResult & {
  from: GitCommitInfo;
  to: GitCommitInfo;
  cached: boolean;
  expandedMacros: string[];
  scratchRelative: string;
  /** `cells`: move-aware cell-level table markup; `atomic`: whole-table notes only (fallback). */
  tableMarkup?: "cells" | "atomic";
};

function err(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const trackQueues = new Map<string, Promise<unknown>>();

async function withTrackChangesLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = trackQueues.get(id) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => gate, () => gate);
  trackQueues.set(id, tail);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (trackQueues.get(id) === tail) trackQueues.delete(id);
  }
}

let latexdiffOverride: boolean | null = null;

/** Test hook. Pass null to restore auto-detect. */
export function setLatexdiffAvailableForTests(value: boolean | null): void {
  latexdiffOverride = value;
}

let latexdiffAvailable: boolean | null = null;

export async function hasLatexdiff(): Promise<boolean> {
  if (latexdiffOverride !== null) return latexdiffOverride;
  if (latexdiffAvailable !== null) return latexdiffAvailable;
  try {
    const r = await runTool("latexdiff", ["--version"], process.cwd(), 5000);
    latexdiffAvailable = r.code === 0 || r.stdout.length > 0 || r.stderr.length > 0;
  } catch {
    latexdiffAvailable = false;
  }
  return latexdiffAvailable;
}

function runTool(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  onChunk?: (chunk: string) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: texEnv() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (buf: Buffer) => {
      stdout += buf.toString("utf8");
    });
    child.stderr.on("data", (buf: Buffer) => {
      const s = buf.toString("utf8");
      stderr += s;
      onChunk?.(s);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += "\n[openleaf] latexdiff timed out\n";
      onChunk?.("\n[openleaf] latexdiff timed out\n");
      resolve({ code: 1, stdout, stderr });
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function resolveTrackChangesCommit(id: string, raw: string): Promise<GitCommitInfo> {
  const trimmed = raw.trim();
  if (!HASH_RE.test(trimmed)) throw err(400, "Invalid commit hash");
  const info = await getProjectCommit(id, trimmed);
  if (!info) throw err(404, "Commit not found");
  return info;
}

export function trackChangesScratchDir(id: string, fromHash: string, toHash: string): string {
  return path.join(projectDir(id), ".openleaf", "track-changes", `${fromHash}_${toHash}`);
}

function markerPath(scratch: string): string {
  return path.join(scratch, MARKER);
}

function readMainFile(root: string, fallback: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, "openleaf.json"), "utf8")) as {
      mainFile?: string;
    };
    if (raw.mainFile?.trim()) return raw.mainFile.trim();
  } catch {
    /* fallback */
  }
  return fallback;
}

function isUnderMisc(rel: string): boolean {
  const n = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return n === "misc" || n.startsWith("misc/");
}

function uncommentedPrefix(line: string): { code: string; comment: string } {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "%" && (i === 0 || line[i - 1] !== "\\")) {
      return { code: line.slice(0, i), comment: line.slice(i) };
    }
  }
  return { code: line, comment: "" };
}

function resolveInput(root: string, fromFile: string, spec: string): string | null {
  const cleaned = spec.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || cleaned.split("/").some((p) => p === "..")) return null;
  const skipRel = cleaned.replace(/\.tex$/i, "").replace(/\.ltx$/i, "");
  if (isUnderMisc(skipRel)) return null;

  const candidates = [cleaned];
  if (!/\.(tex|ltx)$/i.test(cleaned)) {
    candidates.push(`${cleaned}.tex`, `${cleaned}.ltx`);
  }
  const bases = [path.dirname(fromFile), root];
  for (const base of bases) {
    for (const c of candidates) {
      const abs = path.resolve(base, c);
      const rel = path.relative(root, abs);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      if (isUnderMisc(rel.replace(/\\/g, "/"))) return null;
      try {
        if (fs.statSync(abs).isFile()) return abs;
      } catch {
        /* missing */
      }
    }
  }
  return null;
}

const INPUT_RE = /\\(input|include)\s*\{([^}]+)\}/g;

/** Recursively inline `\input` / `\include`, leaving `misc/` untouched. */
export function flattenTexFile(root: string, file: string, seen?: Set<string>): string {
  const abs = path.resolve(file);
  const visited = seen ?? new Set<string>();
  if (visited.has(abs)) return "";
  visited.add(abs);
  const src = fs.readFileSync(abs, "utf8");
  const lines = src.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const { code, comment } = uncommentedPrefix(line);
    const replaced = code.replace(INPUT_RE, (full, _cmd: string, spec: string) => {
      const target = resolveInput(root, abs, spec);
      if (!target) return full;
      const inlined = flattenTexFile(root, target, visited);
      return inlined.replace(/\n$/, "");
    });
    out.push(replaced + comment);
  }
  return out.join("\n");
}

function isLiteralMacroValue(value: string): boolean {
  if (value.length > 300) return false;
  if (/[\\{}$]/.test(value)) return false;
  return true;
}

function sliceBalanced(src: string, innerStart: number): { value: string; end: number } | null {
  let depth = 1;
  for (let i = innerStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { value: src.slice(innerStart, i), end: i + 1 };
    }
  }
  return null;
}

/** No-argument `\newcommand{\Name}{literal}` definitions. */
export function parseNoArgNewcommands(tex: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\\newcommand\*?\{\s*\\([A-Za-z@]+)\s*\}\s*(?:\[(\d+)\]\s*)?\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tex))) {
    if (m[2] && m[2] !== "0") continue;
    const sliced = sliceBalanced(tex, re.lastIndex);
    if (!sliced) continue;
    re.lastIndex = sliced.end;
    if (!isLiteralMacroValue(sliced.value)) continue;
    out.set(m[1], sliced.value);
  }
  return out;
}

function splitPreamble(tex: string): { preamble: string; sep: string; body: string } {
  const m = tex.match(/\\begin\{document\}/);
  if (!m || m.index === undefined) return { preamble: "", sep: "", body: tex };
  const at = m.index + m[0].length;
  return { preamble: tex.slice(0, at), sep: "", body: tex.slice(at) };
}

function expandNamesInBody(tex: string, names: string[], values: Map<string, string>): string {
  if (!names.length) return tex;
  const split = splitPreamble(tex);
  let body = split.body;
  const sorted = [...names].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const val = values.get(name);
    if (val === undefined) continue;
    const re = new RegExp(String.raw`(?<!\\)\\${name}(?:\{\})?(?![A-Za-z@])`, "g");
    body = body.replace(re, `{${val}}`);
  }
  return split.preamble + split.sep + body;
}

/**
 * When a no-arg metrics-style macro changes, splice its literal value into the
 * body so latexdiff marks the in-text number rather than only the preamble def.
 */
export function expandChangedMetricsMacros(
  oldTex: string,
  newTex: string,
): { old: string; new: string; expanded: string[] } {
  const oldCmds = parseNoArgNewcommands(oldTex);
  const newCmds = parseNoArgNewcommands(newTex);
  const expanded: string[] = [];
  for (const [name, newVal] of newCmds) {
    const oldVal = oldCmds.get(name);
    if (oldVal === undefined || oldVal === newVal) continue;
    expanded.push(name);
  }
  return {
    old: expandNamesInBody(oldTex, expanded, oldCmds),
    new: expandNamesInBody(newTex, expanded, newCmds),
    expanded,
  };
}

async function copySnapshotTree(src: string, dest: string): Promise<void> {
  await fsPromises.mkdir(dest, { recursive: true });
  await fsPromises.cp(src, dest, {
    recursive: true,
    filter: (from) => {
      const rel = path.relative(src, from);
      if (!rel || rel === ".") return true;
      const parts = rel.split(path.sep);
      return !parts.some(
        (p) => p === ".git" || p === ".openleaf" || p === "node_modules" || p.startsWith(".openleaf-"),
      );
    },
  });
}

function scratchPdf(id: string, scratch: string, mainFile: string): string {
  return pdfPathAbs(id, mainFile, scratch);
}

export function trackChangesPdfIfCached(
  id: string,
  fromHash: string,
  toHash: string,
  mainFile: string,
): string | null {
  const scratch = trackChangesScratchDir(id, fromHash, toHash);
  if (!fs.existsSync(markerPath(scratch))) return null;
  try {
    const raw = fs.readFileSync(markerPath(scratch), "utf8");
    if (!raw.split(/\n/).includes(`v${MARKER_VERSION}`)) return null;
  } catch {
    return null;
  }
  const pdf = scratchPdf(id, scratch, mainFile);
  return fs.existsSync(pdf) ? pdf : null;
}

export async function findCachedTrackChangesPdf(
  id: string,
  fromRaw: string,
  toRaw: string,
): Promise<{ pdf: string; from: GitCommitInfo; to: GitCommitInfo; mainFile: string } | null> {
  await getProject(id);
  const from = await resolveTrackChangesCommit(id, fromRaw);
  const to = await resolveTrackChangesCommit(id, toRaw);
  const scratch = trackChangesScratchDir(id, from.hash, to.hash);
  const fallback = (await readProjectConfig(id)).mainFile;
  const mainFile = readMainFile(scratch, fallback);
  const pdf = trackChangesPdfIfCached(id, from.hash, to.hash, mainFile);
  if (!pdf) return null;
  return { pdf, from, to, mainFile };
}

export async function generateTrackChanges(
  id: string,
  fromRaw: string,
  toRaw: string,
  onChunk?: (chunk: string) => void,
): Promise<TrackChangesResult> {
  await getProject(id);
  if (!isGitEnabled()) throw err(400, "Git backups are disabled");
  return withTrackChangesLock(id, () => generateTrackChangesUnlocked(id, fromRaw, toRaw, onChunk));
}

async function latexdiffMarkupArgs(): Promise<string[]> {
  try {
    const r = await runTool("kpsewhich", ["ulem.sty"], process.cwd(), 5000);
    if (r.stdout.trim()) return [];
  } catch {
    /* TinyTeX often omits ulem */
  }
  return ["--subtype=COLOR"];
}

async function generateTrackChangesUnlocked(
  id: string,
  fromRaw: string,
  toRaw: string,
  onChunk?: (chunk: string) => void,
): Promise<TrackChangesResult> {
  if (!(await hasLatexdiff())) {
    throw err(501, "latexdiff is not installed (TeX Live latexdiff package)");
  }

  const from = await resolveTrackChangesCommit(id, fromRaw);
  const to = await resolveTrackChangesCommit(id, toRaw);
  if (from.hash === to.hash) throw err(400, "from and to are the same commit");

  const projectCfg = await readProjectConfig(id);
  const scratch = trackChangesScratchDir(id, from.hash, to.hash);
  const scratchRelative = path.relative(projectDir(id), scratch).replace(/\\/g, "/");

  const cachedPdf = trackChangesPdfIfCached(id, from.hash, to.hash, readMainFile(scratch, projectCfg.mainFile));
  if (cachedPdf) {
    onChunk?.(`[openleaf] using cached track-changes PDF ${from.shortHash} → ${to.shortHash}\n`);
    return {
      ok: true,
      engine: projectCfg.engine ?? "pdflatex",
      usedLatexmk: false,
      log: "",
      pdfRelative: path.relative(scratch, cachedPdf).replace(/\\/g, "/"),
      durationMs: 0,
      from,
      to,
      cached: true,
      expandedMacros: [],
      scratchRelative,
    };
  }

  onChunk?.(`[openleaf] track-changes ${from.shortHash} → ${to.shortHash}\n`);
  onChunk?.("[openleaf] materializing snapshots\n");
  const oldSnap = await ensureSnapshotRoot(id, from.hash);
  const newSnap = await ensureSnapshotRoot(id, to.hash);

  const mainFile = readMainFile(newSnap, projectCfg.mainFile);
  const oldMain = path.join(oldSnap, mainFile);
  const newMain = path.join(newSnap, mainFile);
  if (!fs.existsSync(oldMain)) throw err(400, `Main file missing in baseline (${mainFile})`);
  if (!fs.existsSync(newMain)) throw err(400, `Main file missing in target (${mainFile})`);

  onChunk?.("[openleaf] flattening \\input/\\include (skipping misc/)\n");
  const oldFlat = flattenTexFile(oldSnap, oldMain);
  const newFlat = flattenTexFile(newSnap, newMain);
  const expanded = expandChangedMetricsMacros(oldFlat, newFlat);
  if (expanded.expanded.length) {
    onChunk?.(`[openleaf] expanded metrics macros in body: ${expanded.expanded.join(", ")}\n`);
  }

  const oldSrc = unwrapHeadingTargets(expanded.old);
  const newSrc = unwrapHeadingTargets(expanded.new);
  const markupArgs = await latexdiffMarkupArgs();
  if (markupArgs.includes("--subtype=COLOR")) {
    onChunk?.("[openleaf] ulem.sty not found; using color markup instead of underline/strikethrough\n");
  }
  const ldArgs = [
    "--encoding=utf8",
    "--graphics-markup=none",
    `--config=PICTUREENV=${LATEXDIFF_PICTURE_ENV}`,
    "--append-textcmd=captionof",
    ...markupArgs,
  ];

  const build = async (cellTables: boolean): Promise<CompileResult> => {
    await fsPromises.rm(scratch, { recursive: true, force: true });
    await copySnapshotTree(newSnap, scratch);

    const workDir = path.join(scratch, ".openleaf", "latexdiff");
    await fsPromises.mkdir(workDir, { recursive: true });
    const prepared = cellTables ? prepareTableBlocks(oldSrc, newSrc) : null;
    const aligned = alignMovedSections(prepared?.old ?? oldSrc, prepared?.new ?? newSrc);
    if (aligned.moved.length) {
      onChunk?.(`[openleaf] sections moved: ${aligned.moved.join("; ")}\n`);
    }
    const oldFlatPath = path.join(workDir, "old-flat.tex");
    const newFlatPath = path.join(workDir, "new-flat.tex");
    await fsPromises.writeFile(oldFlatPath, aligned.old, "utf8");
    await fsPromises.writeFile(newFlatPath, aligned.new, "utf8");

    onChunk?.(
      cellTables
        ? `[openleaf] latexdiff (${prepared!.blocks.size} table(s) diffed cell-by-cell)\n`
        : "[openleaf] latexdiff (tables as atomic replacements)\n",
    );
    const diffOut = path.join(scratch, mainFile);
    await fsPromises.mkdir(path.dirname(diffOut), { recursive: true });

    const ld = await runTool("latexdiff", [...ldArgs, oldFlatPath, newFlatPath], scratch, LATEXDIFF_TIMEOUT_MS, onChunk);
    if (ld.code !== 0) {
      throw err(500, `latexdiff failed${ld.stderr.trim() ? `: ${ld.stderr.slice(-400)}` : ""}`);
    }

    const marked = ld.stdout;
    if (!marked.trim()) throw err(500, "latexdiff produced an empty file");
    const annotated = annotateReplacedTables(marked);
    if (annotated.tables.changed + annotated.tables.removed > 0) {
      onChunk?.(
        `[openleaf] table notes: ${annotated.tables.changed} changed, ${annotated.tables.removed} removed\n`,
      );
    }
    let tex = annotated.tex;
    if (prepared) {
      let mini = 0;
      const rendered = await renderTableBlocks(tex, prepared.blocks, async (oldBody, newBody) => {
        mini += 1;
        const doc = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
        const a = path.join(workDir, `table-${mini}-old.tex`);
        const b = path.join(workDir, `table-${mini}-new.tex`);
        await fsPromises.writeFile(a, doc(oldBody), "utf8");
        await fsPromises.writeFile(b, doc(newBody), "utf8");
        const r = await runTool("latexdiff", [...ldArgs, a, b], workDir, LATEXDIFF_TIMEOUT_MS);
        const m = /\\begin\{document\}\n?([\s\S]*?)\n?\\end\{document\}/.exec(r.stdout);
        if (r.code !== 0 || !m) throw new Error("latexdiff failed on a table caption block");
        return m[1];
      });
      tex = rendered.tex;
      const s = rendered.stats;
      onChunk?.(
        `[openleaf] tables: ${s.cellLevel} changed (cell-level), ${s.added} new, ${s.moved} moved, ${s.atomic} atomic\n`,
      );
    }
    if (aligned.moved.length) tex = injectPreamble(tex, SECTION_MOVED_PREAMBLE);
    await fsPromises.writeFile(diffOut, tex, "utf8");
    return compileProjectAtRoot(id, onChunk, scratch);
  };

  let tableMarkup: "cells" | "atomic" = "cells";
  let compiled: CompileResult | null = null;
  try {
    compiled = await build(true);
    if (!compiled.ok) {
      onChunk?.("[openleaf] markup PDF did not compile with cell-level tables; retrying with atomic tables\n");
    }
  } catch (e) {
    if ((e as { status?: number }).status) throw e;
    onChunk?.(`[openleaf] cell-level table markup failed (${(e as Error).message}); retrying with atomic tables\n`);
  }
  if (!compiled?.ok) {
    tableMarkup = "atomic";
    compiled = await build(false);
  }
  if (compiled.ok) {
    await fsPromises.writeFile(
      markerPath(scratch),
      `${from.hash}\n${to.hash}\n${mainFile}\nv${MARKER_VERSION}\n`,
      "utf8",
    );
  }

  return {
    ...compiled,
    from,
    to,
    cached: false,
    expandedMacros: expanded.expanded,
    scratchRelative,
    tableMarkup,
  };
}
