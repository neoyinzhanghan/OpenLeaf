import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig, type LatexEngine } from "../config.js";
import {
  outputDirAbs,
  pdfPathAbs,
  projectDir,
  readProjectConfig,
} from "./projectFs.js";

const execFileAsync = promisify(execFile);

export type CompileResult = {
  ok: boolean;
  engine: LatexEngine;
  usedLatexmk: boolean;
  log: string;
  pdfRelative: string | null;
  durationMs: number;
};

let latexmkAvailable: boolean | null = null;

async function hasLatexmk(): Promise<boolean> {
  if (latexmkAvailable !== null) return latexmkAvailable;
  try {
    await execFileAsync("latexmk", ["-v"], { timeout: 5000 });
    latexmkAvailable = true;
  } catch {
    latexmkAvailable = false;
  }
  return latexmkAvailable;
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  onChunk?: (chunk: string) => void,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number; log: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env });
    let log = "";
    const append = (buf: Buffer) => {
      const s = buf.toString("utf8");
      log += s;
      onChunk?.(s);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      log += "\n[openleaf] compile timed out\n";
      resolve({ code: 1, log });
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      log += `\n[openleaf] failed to spawn ${cmd}: ${err.message}\n`;
      resolve({ code: 1, log });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, log });
    });
  });
}

async function compileWithLatexmk(
  cwd: string,
  mainFile: string,
  engine: LatexEngine,
  outDir: string,
  timeoutMs: number,
  onChunk?: (chunk: string) => void,
): Promise<{ code: number; log: string }> {
  const engineFlag = engine === "xelatex" ? "-xelatex" : "-pdf";
  const args = [
    engineFlag,
    "-interaction=nonstopmode",
    "-f",
    "-synctex=1",
    `-outdir=${outDir}`,
    mainFile,
  ];
  return runCommand("latexmk", args, cwd, timeoutMs, onChunk);
}

async function compileFallback(
  cwd: string,
  mainFile: string,
  engine: LatexEngine,
  outDir: string,
  timeoutMs: number,
  onChunk?: (chunk: string) => void,
): Promise<{ code: number; log: string }> {
  const jobname = path.basename(mainFile, path.extname(mainFile));
  const absOut = path.isAbsolute(outDir) ? outDir : path.join(cwd, outDir);
  fs.mkdirSync(absOut, { recursive: true });

  const texArgs = [
    "-interaction=nonstopmode",
    "-synctex=1",
    `-output-directory=${absOut}`,
    mainFile,
  ];

  let log = "";
  const pass = async (label: string) => {
    onChunk?.(`\n[openleaf] ${label}\n`);
    const r = await runCommand(engine, texArgs, cwd, timeoutMs, onChunk);
    log += r.log;
    return r.code;
  };

  let code = await pass(`${engine} (pass 1)`);
  // Always try bibtex if .aux exists — harmless if unused
  const aux = path.join(absOut, `${jobname}.aux`);
  if (fs.existsSync(aux)) {
    onChunk?.("\n[openleaf] bibtex\n");
    const bibEnv = {
      ...process.env,
      BIBINPUTS: `${cwd}${path.delimiter}${process.env.BIBINPUTS ?? ""}`,
      BSTINPUTS: `${cwd}${path.delimiter}${process.env.BSTINPUTS ?? ""}`,
    };
    const bib = await runCommand("bibtex", [jobname], absOut, timeoutMs, onChunk, bibEnv);
    log += bib.log;
  }
  code = await pass(`${engine} (pass 2)`);
  code = await pass(`${engine} (pass 3)`);
  return { code, log };
}

const compileQueues = new Map<string, Promise<unknown>>();

async function withProjectCompileLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = compileQueues.get(id) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => gate, () => gate);
  compileQueues.set(id, tail);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (compileQueues.get(id) === tail) compileQueues.delete(id);
  }
}

async function compileProjectUnlocked(
  id: string,
  onChunk?: (chunk: string) => void,
  rootDir?: string,
): Promise<CompileResult> {
  const started = Date.now();
  const cfg = loadConfig();
  const projectCfg = await readProjectConfig(id);
  const engine = projectCfg.engine ?? cfg.latex.engine;
  const cwd = rootDir ?? projectDir(id);
  const outRel = cfg.latex.outputDir;
  const outAbs = outputDirAbs(id, cwd);
  fs.mkdirSync(outAbs, { recursive: true });

  const useMk = await hasLatexmk();
  onChunk?.(
    useMk
      ? `[openleaf] compiling with latexmk (${engine})\n`
      : `[openleaf] latexmk not found; using ${engine} + bibtex fallback\n`,
  );

  const result = useMk
    ? await compileWithLatexmk(cwd, projectCfg.mainFile, engine, outRel, cfg.latex.timeoutMs, onChunk)
    : await compileFallback(cwd, projectCfg.mainFile, engine, outRel, cfg.latex.timeoutMs, onChunk);

  const pdfAbs = pdfPathAbs(id, projectCfg.mainFile, cwd);
  // TeX often exits non-zero on warnings/errors even when a PDF was written.
  const ok = fs.existsSync(pdfAbs);
  const pdfRelative = ok ? path.relative(cwd, pdfAbs).replace(/\\/g, "/") : null;

  if (!ok) {
    onChunk?.("\n[openleaf] compile finished without a PDF (check log for errors)\n");
  } else if (result.code !== 0) {
    onChunk?.("\n[openleaf] PDF written with TeX warnings/errors (see log)\n");
  }

  return {
    ok,
    engine,
    usedLatexmk: useMk,
    log: result.log,
    pdfRelative,
    durationMs: Date.now() - started,
  };
}

/** Flush collab CRDT to disk (if a room is open), then compile. Serialized per project. */
export async function compileProject(
  id: string,
  onChunk?: (chunk: string) => void,
  opts?: { branchId?: string },
): Promise<CompileResult> {
  return withProjectCompileLock(id, async () => {
    const { flushProjectRoom } = await import("./collab/room.js");
    const { ensureBranchRoot } = await import("./timeline.js");
    const branchId = opts?.branchId ?? "main";
    onChunk?.(`[openleaf] flushing collaborative edits to disk (${branchId})\n`);
    await flushProjectRoom(id, { commit: false, branchId });
    const root = await ensureBranchRoot(id, branchId);
    return compileProjectUnlocked(id, onChunk, root);
  });
}
