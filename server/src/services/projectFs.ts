import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { getProjectsRootAbs, loadConfig, type Identity, type LatexEngine } from "../config.js";

/** Never list or zip these system dirs. Build artifacts (`.openleaf`) stay visible. */
export const SKIP_DIRS = new Set([".git", "node_modules"]);
/** Omit from ZIP exports only */
export const ZIP_SKIP_DIRS = new Set([".openleaf", ".git", "node_modules"]);

export type TreeNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
};

export type ProjectMeta = {
  id: string;
  name: string;
  mainFile: string;
  engine: LatexEngine;
  path: string;
};

export type PaperflowProjectConfig = {
  mainFile: string;
  engine?: LatexEngine;
  /** Project-specific collab identities (authoritative for this project). */
  identities?: Identity[];
};

const DEFAULT_PROJECT_IDENTITIES: Identity[] = [
  { id: "admin-neo", name: "Admin Neo", color: "#0F766E" },
];

export function defaultProjectIdentities(): Identity[] {
  const fromConfig = loadConfig().defaultIdentities;
  return fromConfig.length > 0 ? fromConfig.map((i) => ({ ...i })) : DEFAULT_PROJECT_IDENTITIES.map((i) => ({ ...i }));
}

function assertSafeProjectId(id: string): string {
  if (!id || id.includes("/") || id.includes("\\") || id === "." || id === "..") {
    throw Object.assign(new Error("Invalid project id"), { status: 400 });
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw Object.assign(new Error("Invalid project id"), { status: 400 });
  }
  return id;
}

export function projectDir(id: string): string {
  const safe = assertSafeProjectId(id);
  const root = getProjectsRootAbs();
  const dir = path.resolve(root, safe);
  if (!dir.startsWith(root + path.sep) && dir !== root) {
    throw Object.assign(new Error("Path escape"), { status: 400 });
  }
  return dir;
}

/** Resolve a path inside an arbitrary project root (main dir or worktree). */
export function resolveRootPath(rootDir: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.split("/").some((p) => p === "..")) {
    throw Object.assign(new Error("Path escape"), { status: 400 });
  }
  const full = path.resolve(rootDir, normalized);
  if (!full.startsWith(rootDir + path.sep) && full !== rootDir) {
    throw Object.assign(new Error("Path escape"), { status: 400 });
  }
  return full;
}

/** Resolve a path inside a project; rejects escapes and absolute inputs. */
export function resolveProjectPath(id: string, relativePath: string): string {
  return resolveRootPath(projectDir(id), relativePath);
}

export async function ensureProjectsRoot(): Promise<void> {
  await fs.mkdir(getProjectsRootAbs(), { recursive: true });
}

export async function readProjectConfig(id: string): Promise<PaperflowProjectConfig> {
  const cfgPath = resolveProjectPath(id, "openleaf.json");
  const globalEngine = loadConfig().latex.engine;
  try {
    const raw = JSON.parse(await fs.readFile(cfgPath, "utf8")) as Partial<PaperflowProjectConfig>;
    return {
      mainFile: raw.mainFile ?? "main.tex",
      engine: raw.engine ?? globalEngine,
      identities: Array.isArray(raw.identities) ? raw.identities : undefined,
    };
  } catch {
    return { mainFile: "main.tex", engine: globalEngine };
  }
}

export async function getProjectIdentities(id: string): Promise<Identity[]> {
  const cfg = await readProjectConfig(id);
  if (cfg.identities && cfg.identities.length > 0) {
    // Soft-validate; skip malformed entries rather than failing the project open
    return cfg.identities.filter(
      (i) =>
        typeof i?.id === "string" &&
        typeof i?.name === "string" &&
        typeof i?.color === "string" &&
        /^#[0-9A-Fa-f]{6}$/.test(i.color),
    );
  }
  return defaultProjectIdentities();
}

export async function getProjectIdentity(projectId: string, identityId: string): Promise<Identity | undefined> {
  const list = await getProjectIdentities(projectId);
  return list.find((i) => i.id === identityId);
}

export async function writeProjectConfig(
  id: string,
  patch: Partial<PaperflowProjectConfig>,
): Promise<PaperflowProjectConfig> {
  const current = await readProjectConfig(id);
  const next: PaperflowProjectConfig = {
    mainFile: patch.mainFile ?? current.mainFile,
    engine: patch.engine ?? current.engine,
    identities: patch.identities ?? current.identities,
  };
  if (!next.identities) delete next.identities;
  const cfgPath = resolveProjectPath(id, "openleaf.json");
  await fs.writeFile(cfgPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export async function listProjects(): Promise<ProjectMeta[]> {
  await ensureProjectsRoot();
  const root = getProjectsRootAbs();
  const entries = await fs.readdir(root, { withFileTypes: true });
  const projects: ProjectMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      assertSafeProjectId(entry.name);
    } catch {
      continue;
    }
    const cfg = await readProjectConfig(entry.name);
    projects.push({
      id: entry.name,
      name: entry.name,
      mainFile: cfg.mainFile,
      engine: cfg.engine ?? loadConfig().latex.engine,
      path: path.join(root, entry.name),
    });
  }
  projects.sort((a, b) => a.id.localeCompare(b.id));
  return projects;
}

export async function getProject(id: string): Promise<ProjectMeta> {
  const dir = projectDir(id);
  if (!fsSync.existsSync(dir)) {
    throw Object.assign(new Error("Project not found"), { status: 404 });
  }
  const cfg = await readProjectConfig(id);
  return {
    id,
    name: id,
    mainFile: cfg.mainFile,
    engine: cfg.engine ?? loadConfig().latex.engine,
    path: dir,
  };
}

async function buildTree(absDir: string, relBase: string): Promise<TreeNode[]> {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const nodes: TreeNode[] = [];
  for (const entry of entries.sort((a, b) => {
    // dirs first, then alpha; keep dotfiles
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: rel,
        type: "directory",
        children: await buildTree(path.join(absDir, entry.name), rel),
      });
    } else {
      nodes.push({ name: entry.name, path: rel, type: "file" });
    }
  }
  return nodes;
}

export async function getTree(id: string, rootDir?: string): Promise<TreeNode[]> {
  const dir = rootDir ?? projectDir(id);
  if (!fsSync.existsSync(dir)) {
    throw Object.assign(new Error("Project not found"), { status: 404 });
  }
  return buildTree(dir, "");
}

const BINARY_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".eps",
  ".ps",
  ".zip",
  ".gz",
  ".tgz",
  ".xz",
  ".7z",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".wav",
    ".bin",
    ".db",
    ".sqlite",
    ".sqlite3",
    ".parquet",
    ".h5",
    ".npy",
    ".npz",
    ".pkl",
    ".pickle",
    ".o",
  ".a",
  ".so",
  ".dylib",
  ".exe",
  ".dll",
]);

const TEXT_HINT_EXT = new Set([
  ".tex",
  ".bib",
  ".cls",
  ".sty",
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".svg",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".yaml",
  ".yml",
  ".log",
  ".bst",
  ".bbl",
  ".aux",
  ".out",
  ".toc",
  ".lof",
  ".lot",
  ".nav",
  ".snm",
  ".vrb",
  ".dtx",
  ".ins",
  ".ltx",
  ".mk",
  ".makefile",
  ".r",
  ".rb",
  ".go",
  ".rs",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".java",
  ".xml",
  ".plist",
  ".gitignore",
  ".env",
  ".editorconfig",
]);

export function looksLikeText(buf: Buffer): boolean {
  if (buf.length === 0) return true;
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  if (sample.includes(0)) return false;
  let weird = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const c = sample[i]!;
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 127) weird += 1;
  }
  return weird / sample.length < 0.03;
}

export function isTextPath(filePath: string, buf?: Buffer): boolean {
  const name = path.basename(filePath).toLowerCase();
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXT.has(ext)) return false;
  if (TEXT_HINT_EXT.has(ext) || TEXT_HINT_EXT.has(name) || name === "makefile" || name === "dockerfile") {
    return true;
  }
  if (buf) return looksLikeText(buf);
  if (!fsSync.existsSync(filePath)) return true;
  try {
    const fd = fsSync.openSync(filePath, "r");
    const sample = Buffer.alloc(8192);
    const n = fsSync.readSync(fd, sample, 0, 8192, 0);
    fsSync.closeSync(fd);
    return looksLikeText(sample.subarray(0, n));
  } catch {
    return false;
  }
}

function contentTypeFor(filePath: string, asText: boolean): string {
  if (asText) return "text/plain; charset=utf-8";
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Do not inline file bodies larger than this into the JSON API / browser editor. */
export const MAX_INLINE_FILE_BYTES = 1.5 * 1024 * 1024;

export async function readFile(
  id: string,
  relativePath: string,
  opts?: { forceText?: boolean; meta?: boolean; rootDir?: string },
): Promise<{
  encoding: "utf8" | "base64";
  content: string;
  contentType: string;
  size: number;
  text: boolean;
  contentOmitted?: boolean;
}> {
  const full = opts?.rootDir
    ? resolveRootPath(opts.rootDir, relativePath)
    : resolveProjectPath(id, relativePath);
  if (!fsSync.existsSync(full) || fsSync.statSync(full).isDirectory()) {
    throw Object.assign(new Error("File not found"), { status: 404 });
  }
  const st = fsSync.statSync(full);
  const sample = Buffer.alloc(Math.min(8192, st.size));
  if (st.size > 0) {
    const fd = fsSync.openSync(full, "r");
    try {
      fsSync.readSync(fd, sample, 0, sample.length, 0);
    } finally {
      fsSync.closeSync(fd);
    }
  }
  const asText = opts?.forceText === true || isTextPath(full, sample);
  const omitBody = opts?.meta === true || st.size > MAX_INLINE_FILE_BYTES;
  if (omitBody) {
    return {
      encoding: asText ? "utf8" : "base64",
      content: "",
      contentType: contentTypeFor(full, asText),
      size: st.size,
      text: asText,
      contentOmitted: st.size > MAX_INLINE_FILE_BYTES,
    };
  }
  const buf = await fs.readFile(full);
  if (asText) {
    return {
      encoding: "utf8",
      content: buf.toString("utf8"),
      contentType: contentTypeFor(full, true),
      size: buf.length,
      text: true,
    };
  }
  return {
    encoding: "base64",
    content: buf.toString("base64"),
    contentType: contentTypeFor(full, false),
    size: buf.length,
    text: false,
  };
}

export async function writeFile(
  id: string,
  relativePath: string,
  content: string,
  encoding: "utf8" | "base64" = "utf8",
  rootDir?: string,
): Promise<void> {
  const full = rootDir
    ? resolveRootPath(rootDir, relativePath)
    : resolveProjectPath(id, relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  if (encoding === "base64") {
    await fs.writeFile(full, Buffer.from(content, "base64"));
  } else {
    await fs.writeFile(full, content, "utf8");
  }
}

function assertWritableRel(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((p) => p === ".." || p === "")) {
    throw Object.assign(new Error("Invalid path"), { status: 400 });
  }
  return normalized;
}

export async function deletePath(id: string, relativePath: string, rootDir?: string): Promise<void> {
  const rel = assertWritableRel(relativePath);
  if (rel === "openleaf.json") {
    throw Object.assign(new Error("Refusing to delete openleaf.json"), { status: 400 });
  }
  const full = rootDir ? resolveRootPath(rootDir, rel) : resolveProjectPath(id, rel);
  if (!fsSync.existsSync(full)) {
    throw Object.assign(new Error("Path not found"), { status: 404 });
  }
  await fs.rm(full, { recursive: true, force: true });
}

export async function mkdirPath(id: string, relativePath: string, rootDir?: string): Promise<void> {
  const rel = assertWritableRel(relativePath);
  const full = rootDir ? resolveRootPath(rootDir, rel) : resolveProjectPath(id, rel);
  await fs.mkdir(full, { recursive: true });
}

export async function renamePath(
  id: string,
  from: string,
  to: string,
  rootDir?: string,
): Promise<void> {
  const fromRel = assertWritableRel(from);
  const toRel = assertWritableRel(to);
  const fromFull = rootDir ? resolveRootPath(rootDir, fromRel) : resolveProjectPath(id, fromRel);
  const toFull = rootDir ? resolveRootPath(rootDir, toRel) : resolveProjectPath(id, toRel);
  if (!fsSync.existsSync(fromFull)) {
    throw Object.assign(new Error("Source not found"), { status: 404 });
  }
  if (fsSync.existsSync(toFull)) {
    throw Object.assign(new Error("Destination already exists"), { status: 409 });
  }
  await fs.mkdir(path.dirname(toFull), { recursive: true });
  await fs.rename(fromFull, toFull);
}

export async function createEmptyFile(
  id: string,
  relativePath: string,
  content = "",
  rootDir?: string,
): Promise<void> {
  const rel = assertWritableRel(relativePath);
  const full = rootDir ? resolveRootPath(rootDir, rel) : resolveProjectPath(id, rel);
  if (fsSync.existsSync(full)) {
    throw Object.assign(new Error("File already exists"), { status: 409 });
  }
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
}

export async function createProject(id: string, fromTemplate = "example-article"): Promise<ProjectMeta> {
  assertSafeProjectId(id);
  const dest = projectDir(id);
  if (fsSync.existsSync(dest)) {
    throw Object.assign(new Error("Project already exists"), { status: 409 });
  }
  const templateDir = path.join(getProjectsRootAbs(), fromTemplate);
  if (!fsSync.existsSync(templateDir)) {
    await fs.mkdir(dest, { recursive: true });
    await fs.mkdir(path.join(dest, "figures"), { recursive: true });
    await fs.writeFile(
      path.join(dest, "main.tex"),
      `\\documentclass{article}\n\\begin{document}\nHello from ${id}.\n\\end{document}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(dest, "references.bib"), "% bibliography\n", "utf8");
    await fs.writeFile(
      path.join(dest, "openleaf.json"),
      `${JSON.stringify(
        {
          mainFile: "main.tex",
          engine: "pdflatex",
          identities: defaultProjectIdentities(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } else {
    await copyDir(templateDir, dest);
    // Ensure identities exist on copied projects
    try {
      const cfg = await readProjectConfig(id);
      if (!cfg.identities || cfg.identities.length === 0) {
        await writeProjectConfig(id, { identities: defaultProjectIdentities() });
      }
    } catch {
      /* ignore */
    }
  }
  // Initialize per-project git backup repo with an initial snapshot
  try {
    const { ensureProjectGit, autoCommitProject } = await import("./projectGit.js");
    await ensureProjectGit(id);
    await autoCommitProject(id, { message: "Initial project snapshot" });
  } catch (err) {
    console.error("[git] init on createProject failed", err);
  }
  return getProject(id);
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || entry.name === ".openleaf" || entry.name === ".git") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else {
      await fs.copyFile(s, d);
    }
  }
}

export function outputDirAbs(id: string, rootDir?: string): string {
  const cfg = loadConfig();
  const base = rootDir ?? projectDir(id);
  const out = cfg.latex.outputDir;
  return path.isAbsolute(out) ? out : path.resolve(base, out);
}

export function pdfPathAbs(id: string, mainFile: string, rootDir?: string): string {
  const base = path.basename(mainFile, path.extname(mainFile));
  return path.join(outputDirAbs(id, rootDir), `${base}.pdf`);
}

export function synctexPathAbs(id: string, mainFile: string, rootDir?: string): string {
  const base = path.basename(mainFile, path.extname(mainFile));
  return path.join(outputDirAbs(id, rootDir), `${base}.synctex.gz`);
}
