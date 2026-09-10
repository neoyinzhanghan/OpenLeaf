import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../config.js";
import { projectDir, resolveProjectPath, resolveRootPath } from "./projectFs.js";

const execFileAsync = promisify(execFile);

export type GitAuthor = {
  name: string;
  email?: string;
};

export type GitCommitInfo = {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  email: string;
  date: string;
};

export type GitCommitResult = {
  committed: boolean;
  hash: string | null;
  message: string;
  skipped?: "disabled" | "clean" | "error";
  error?: string;
};

const GITIGNORE = `# OpenLeaf build + collab runtime (not source)
.openleaf/
`;

function gitEnv(author?: GitAuthor): NodeJS.ProcessEnv {
  const name = author?.name?.trim() || "OpenLeaf";
  const email = author?.email?.trim() || "openleaf@local";
  return {
    ...process.env,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function runGit(
  id: string,
  args: string[],
  opts?: { author?: GitAuthor; allowFailure?: boolean; cwd?: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cwd = opts?.cwd ?? projectDir(id);
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      env: gitEnv(opts?.author),
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    if (opts?.allowFailure) {
      return {
        stdout: String(e.stdout ?? ""),
        stderr: String(e.stderr ?? e.message ?? ""),
        code: typeof e.code === "number" ? e.code : 1,
      };
    }
    throw Object.assign(new Error(e.stderr || e.message || "git failed"), { status: 500 });
  }
}

export function isGitEnabled(): boolean {
  return loadConfig().git?.enabled !== false;
}

/** Ensure the project is a git repo with a sensible .gitignore. */
export async function ensureProjectGit(id: string): Promise<void> {
  if (!isGitEnabled()) return;
  const root = projectDir(id);
  const gitDir = path.join(root, ".git");
  if (!fsSync.existsSync(gitDir)) {
    // Prefer `main` (portable across Git < 2.28 that lack `git init -b`).
    const init = await runGit(id, ["init", "-b", "main"], { allowFailure: true });
    if (init.code !== 0) {
      await runGit(id, ["init"]);
      await runGit(id, ["symbolic-ref", "HEAD", "refs/heads/main"], { allowFailure: true });
    }
    await runGit(id, ["config", "core.autocrlf", "false"], { allowFailure: true });
  }

  const ignorePath = path.join(root, ".gitignore");
  if (!fsSync.existsSync(ignorePath)) {
    await fs.writeFile(ignorePath, GITIGNORE, "utf8");
  } else {
    const cur = await fs.readFile(ignorePath, "utf8");
    if (!cur.split(/\r?\n/).some((l) => l.trim() === ".openleaf/")) {
      await fs.writeFile(
        ignorePath,
        `${cur.replace(/\s*$/, "")}\n\n# OpenLeaf\n.openleaf/\n`,
        "utf8",
      );
    }
  }
}

function defaultMessage(hint?: string): string {
  const ts = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  return hint?.trim() || `Autosave ${ts}`;
}

/**
 * Normalize commit pathspecs and reject `..` / escapes. Returns undefined when
 * the caller wants a full-tree snapshot (`git add -A`).
 */
function commitPathspecs(id: string, paths?: string[]): string[] | undefined {
  if (!paths?.length) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const normalized = raw.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized) continue;
    resolveProjectPath(id, normalized);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out.length ? out : undefined;
}

/**
 * Stage source files and commit if there are changes.
 * Pass `paths` to snapshot only those files (e.g. comments.json); otherwise
 * stages the whole tree (`git add -A`). Safe to call after every save/flush.
 */
export async function autoCommitProject(
  id: string,
  opts?: { message?: string; author?: GitAuthor; paths?: string[] },
): Promise<GitCommitResult> {
  if (!isGitEnabled()) {
    return { committed: false, hash: null, message: "", skipped: "disabled" };
  }

  try {
    await ensureProjectGit(id);
    const paths = commitPathspecs(id, opts?.paths);
    if (paths) {
      await runGit(id, ["add", "--", ...paths]);
    } else {
      await runGit(id, ["add", "-A"]);
    }

    const status = paths
      ? await runGit(id, ["diff", "--cached", "--name-only", "--", ...paths], { allowFailure: true })
      : await runGit(id, ["status", "--porcelain"], { allowFailure: true });
    if (!status.stdout.trim()) {
      return { committed: false, hash: null, message: "", skipped: "clean" };
    }

    const message = defaultMessage(opts?.message);
    const commit = await runGit(
      id,
      paths
        ? ["commit", "-m", message, "--no-gpg-sign", "--", ...paths]
        : ["commit", "-m", message, "--no-gpg-sign"],
      { author: opts?.author, allowFailure: true },
    );

    if (commit.code !== 0) {
      if (/nothing to commit/i.test(commit.stdout + commit.stderr)) {
        return { committed: false, hash: null, message, skipped: "clean" };
      }
      return {
        committed: false,
        hash: null,
        message,
        skipped: "error",
        error: commit.stderr || commit.stdout || "commit failed",
      };
    }

    const rev = await runGit(id, ["rev-parse", "HEAD"]);
    const hash = rev.stdout.trim();
    return {
      committed: true,
      hash,
      message,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "git failed";
    console.error("[git] autoCommit failed", id, msg);
    return { committed: false, hash: null, message: "", skipped: "error", error: msg };
  }
}

export async function listProjectCommits(
  id: string,
  limit = 50,
): Promise<GitCommitInfo[]> {
  if (!isGitEnabled()) return [];
  await ensureProjectGit(id);

  const n = Math.min(200, Math.max(1, limit));
  const log = await runGit(
    id,
    [
      "log",
      `-n${n}`,
      "--pretty=format:%H%x09%h%x09%an%x09%ae%x09%aI%x09%s",
    ],
    { allowFailure: true },
  );

  if (log.code !== 0 || !log.stdout.trim()) return [];

  return log.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, author, email, date, ...rest] = line.split("\t");
      return {
        hash: hash!,
        shortHash: shortHash!,
        author: author!,
        email: email!,
        date: date!,
        message: rest.join("\t"),
      };
    });
}

/**
 * Restore project working tree files from a commit (does not move HEAD).
 * Also removes working-tree files that are absent from that commit (except .openleaf / .git).
 */
export async function restoreProjectCommit(id: string, hash: string): Promise<void> {
  if (!isGitEnabled()) {
    throw Object.assign(new Error("Git backups are disabled"), { status: 400 });
  }
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
    throw Object.assign(new Error("Invalid commit hash"), { status: 400 });
  }
  await ensureProjectGit(id);

  const verify = await runGit(id, ["cat-file", "-t", hash], { allowFailure: true });
  if (verify.code !== 0 || !verify.stdout.includes("commit")) {
    throw Object.assign(new Error("Commit not found"), { status: 404 });
  }

  const diff = await runGit(
    id,
    ["diff", "--name-only", "--diff-filter=A", `${hash}..HEAD`],
    { allowFailure: true },
  );
  const toRemove = diff.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((p) => !p.startsWith(".openleaf/") && p !== ".openleaf" && !p.startsWith(".git/"));

  await runGit(id, ["checkout", hash, "--", "."]);

  const root = projectDir(id);
  for (const rel of toRemove) {
    const full = path.join(root, rel);
    try {
      await fs.rm(full, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  await runGit(id, ["reset", "HEAD"], { allowFailure: true });
}

const HASH_RE = /^[0-9a-f]{7,40}$/i;

export function isManuscriptTexPath(rel: string): boolean {
  const n = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!n || n.startsWith(".openleaf/") || n.startsWith(".git/")) return false;
  if (n === "misc" || n.startsWith("misc/")) return false;
  return n.endsWith(".tex") || n.endsWith(".ltx");
}

export function isHighlightableTexLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith("%")) return false;
  return true;
}

function parseCommitLine(line: string): GitCommitInfo | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const [hash, shortHash, author, email, date, ...rest] = trimmed.split("\t");
  if (!hash || !shortHash || !date) return null;
  return {
    hash,
    shortHash,
    author: author || "OpenLeaf",
    email: email || "",
    date,
    message: rest.join("\t"),
  };
}

export async function getProjectCommit(id: string, hash: string): Promise<GitCommitInfo | null> {
  if (!isGitEnabled()) return null;
  if (!HASH_RE.test(hash)) return null;
  await ensureProjectGit(id);
  const log = await runGit(
    id,
    ["log", "-1", "--pretty=format:%H%x09%h%x09%an%x09%ae%x09%aI%x09%s", hash],
    { allowFailure: true },
  );
  if (log.code !== 0 || !log.stdout.trim()) return null;
  return parseCommitLine(log.stdout.split("\n")[0] ?? "");
}

/** Oldest commit on HEAD (template / first snapshot). */
export async function getRootProjectCommit(id: string): Promise<GitCommitInfo | null> {
  if (!isGitEnabled()) return null;
  await ensureProjectGit(id);
  const rev = await runGit(id, ["rev-list", "--max-parents=0", "HEAD"], { allowFailure: true });
  const hash = rev.stdout.trim().split("\n").filter(Boolean)[0];
  if (!hash) return null;
  return getProjectCommit(id, hash);
}

export type AddedTexLines = {
  file: string;
  lines: number[];
  /** Whole file is new — match every SyncTeX hbox, not just non-blank lines. */
  entireFile?: boolean;
};

export type ParsedAddedDiff = {
  byFile: Map<string, number[]>;
  newFiles: Set<string>;
};

export type DiffDeletedHunk = {
  /** Insert view zone after this 1-based line in the *new* file (0 = before first line). */
  afterLine: number;
  lines: string[];
};

export type FileChangeDiff = {
  file: string;
  status: "added" | "deleted" | "modified" | "renamed";
  /** Previous path when renamed. */
  fromFile?: string;
  addedLines: number[];
  deletedHunks: DiffDeletedHunk[];
  additions: number;
  deletions: number;
  /** True when the whole file is new (every line is an addition). */
  entireFile?: boolean;
};

export type WorkingTreeChanges = {
  files: FileChangeDiff[];
  additions: number;
  deletions: number;
};

export function isDiffableSourcePath(rel: string): boolean {
  const n = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!n || n.startsWith(".openleaf/") || n.startsWith(".git/")) return false;
  if (n === ".gitignore" || n === "openleaf.json" || n === "comments.json") return true;
  const ext = path.extname(n).toLowerCase();
  if (
    [
      ".tex",
      ".ltx",
      ".bib",
      ".sty",
      ".cls",
      ".bst",
      ".md",
      ".txt",
      ".json",
      ".csv",
      ".yaml",
      ".yml",
      ".toml",
      ".py",
      ".sh",
      ".r",
      ".js",
      ".ts",
      ".tsx",
      ".css",
      ".html",
      ".svg",
    ].includes(ext)
  ) {
    return true;
  }
  return false;
}

/**
 * Source lines added in manuscript .tex files since `since` (working tree vs that commit).
 * Skips `misc/`, comments, and blank lines.
 */
export async function listAddedManuscriptLines(
  id: string,
  since: string,
): Promise<AddedTexLines[]> {
  const changes = await listWorkingTreeChanges(id, since, { manuscriptTexOnly: true });
  return changes.files
    .filter((f) => f.status !== "deleted" && (f.addedLines.length || f.entireFile))
    .map((f) => ({
      file: f.file,
      lines: f.addedLines,
      entireFile: f.entireFile,
    }));
}

/**
 * Full working-tree vs commit changes for the editor “show changes” UI.
 * Includes additions, deletions, and file create/delete/rename.
 */
export async function listWorkingTreeChanges(
  id: string,
  since: string,
  opts?: { manuscriptTexOnly?: boolean; cwd?: string; /** If set, diff `since..until` instead of working tree. */ until?: string },
): Promise<WorkingTreeChanges> {
  if (!isGitEnabled()) return { files: [], additions: 0, deletions: 0 };
  if (!HASH_RE.test(since)) {
    throw Object.assign(new Error("Invalid commit hash"), { status: 400 });
  }
  if (opts?.until && !HASH_RE.test(opts.until)) {
    throw Object.assign(new Error("Invalid commit hash"), { status: 400 });
  }
  await ensureProjectGit(id);

  const cwd = opts?.cwd ?? projectDir(id);

  const verify = await runGit(id, ["cat-file", "-t", since], { allowFailure: true, cwd });
  if (verify.code !== 0 || !verify.stdout.includes("commit")) {
    throw Object.assign(new Error("Commit not found"), { status: 404 });
  }
  if (opts?.until) {
    const verifyUntil = await runGit(id, ["cat-file", "-t", opts.until], { allowFailure: true, cwd });
    if (verifyUntil.code !== 0 || !verifyUntil.stdout.includes("commit")) {
      throw Object.assign(new Error("Commit not found"), { status: 404 });
    }
  }

  const diffArgs = opts?.until
    ? ["diff", "-U0", "--find-renames", "--diff-filter=ACMRD", since, opts.until]
    : ["diff", "-U0", "--find-renames", "--diff-filter=ACMRD", since];
  const diff = await runGit(id, diffArgs, { allowFailure: true, cwd });

  const parsed = parseWorkingTreeDiff(diff.stdout);

  // Untracked files → entire-file additions (working tree only)
  if (!opts?.until) {
    const untracked = await runGit(id, ["ls-files", "--others", "--exclude-standard"], {
      allowFailure: true,
      cwd,
    });
    for (const rel of untracked.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
      if (parsed.has(rel)) continue;
      const ok = opts?.manuscriptTexOnly ? isManuscriptTexPath(rel) : isDiffableSourcePath(rel);
      if (!ok) continue;
      try {
        const full = resolveRootPath(cwd, rel);
        const text = await fs.readFile(full, "utf8");
        const raw = text.split(/\n/);
        const addedLines: number[] = [];
        for (let i = 0; i < raw.length; i += 1) {
          if (opts?.manuscriptTexOnly) {
            if (isHighlightableTexLine(raw[i] ?? "")) addedLines.push(i + 1);
          } else if ((raw[i] ?? "").length > 0 || i < raw.length - 1) {
            addedLines.push(i + 1);
          }
        }
        // empty file still counts as added file
        parsed.set(rel, {
          file: rel,
          status: "added",
          addedLines,
          deletedHunks: [],
          additions: addedLines.length,
          deletions: 0,
          entireFile: true,
        });
      } catch {
        /* ignore */
      }
    }
  }

  let files = [...parsed.values()];
  if (opts?.manuscriptTexOnly) {
    files = files.filter((f) => isManuscriptTexPath(f.file) || (f.fromFile ? isManuscriptTexPath(f.fromFile) : false));
  } else {
    files = files.filter((f) => isDiffableSourcePath(f.file) || (f.fromFile ? isDiffableSourcePath(f.fromFile) : false));
  }

  files.sort((a, b) => a.file.localeCompare(b.file));
  const additions = files.reduce((s, f) => s + f.additions, 0);
  const deletions = files.reduce((s, f) => s + f.deletions, 0);
  return { files, additions, deletions };
}

/** Exported for tests / reuse. */
export function parseAddedLinesFromUnifiedDiff(diff: string): ParsedAddedDiff {
  const full = parseWorkingTreeDiff(diff);
  const byFile = new Map<string, number[]>();
  const newFiles = new Set<string>();
  for (const f of full.values()) {
    if (f.status === "deleted") continue;
    byFile.set(
      f.file,
      f.addedLines.filter((n) => {
        // legacy filter used highlightable only for tex path — keep lines as-is here;
        // listAddedManuscriptLines re-filters via manuscript path
        return n > 0;
      }),
    );
    if (f.entireFile || f.status === "added") newFiles.add(f.file);
  }
  return { byFile, newFiles };
}

export function parseWorkingTreeDiff(diff: string): Map<string, FileChangeDiff> {
  const out = new Map<string, FileChangeDiff>();
  let file: string | null = null;
  let fromFile: string | undefined;
  let status: FileChangeDiff["status"] = "modified";
  let newLine = 0;
  let inHunk = false;
  let pendingNew = false;
  let pendingDel = false;
  let curDeleted: string[] = [];
  let deletedAfter = 0;

  const ensure = (): FileChangeDiff | null => {
    if (!file) return null;
    let entry = out.get(file);
    if (!entry) {
      entry = {
        file,
        status,
        fromFile,
        addedLines: [],
        deletedHunks: [],
        additions: 0,
        deletions: 0,
        entireFile: status === "added",
      };
      out.set(file, entry);
    }
    return entry;
  };

  const flushDeleted = () => {
    if (!curDeleted.length) return;
    const entry = ensure();
    if (entry) {
      entry.deletedHunks.push({ afterLine: deletedAfter, lines: curDeleted });
      entry.deletions += curDeleted.length;
    }
    curDeleted = [];
  };

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      flushDeleted();
      file = null;
      fromFile = undefined;
      status = "modified";
      inHunk = false;
      pendingNew = false;
      pendingDel = false;
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      if (m) {
        fromFile = m[1];
        file = m[2] ?? m[1] ?? null;
      }
      continue;
    }
    if (raw.startsWith("new file mode")) {
      pendingNew = true;
      status = "added";
      continue;
    }
    if (raw.startsWith("deleted file mode")) {
      pendingDel = true;
      status = "deleted";
      continue;
    }
    if (raw.startsWith("rename from ")) {
      status = "renamed";
      fromFile = raw.slice("rename from ".length).trim();
      continue;
    }
    if (raw.startsWith("rename to ")) {
      status = "renamed";
      file = raw.slice("rename to ".length).trim();
      continue;
    }
    if (raw === "--- /dev/null") {
      pendingNew = true;
      status = status === "renamed" ? status : "added";
      continue;
    }
    if (raw.startsWith("--- ")) {
      const spec = (raw.slice(4).split("\t")[0] ?? "").trim().replace(/^"|"$/g, "").replace(/^a\//, "");
      if (spec && spec !== "/dev/null") fromFile = spec;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      flushDeleted();
      const spec = (raw.slice(4).split("\t")[0] ?? "").trim().replace(/^"|"$/g, "");
      if (spec === "/dev/null") {
        status = "deleted";
        file = fromFile ?? file;
        pendingDel = true;
        ensure();
        continue;
      }
      file = spec.replace(/^[ab]\//, "");
      if (pendingNew) status = "added";
      pendingNew = false;
      ensure();
      continue;
    }
    const hunk = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(raw);
    if (hunk) {
      flushDeleted();
      newLine = Number(hunk[3]);
      const newCount = hunk[4] !== undefined ? Number(hunk[4]) : 1;
      deletedAfter = newCount === 0 ? Math.max(0, newLine - 1) : Math.max(0, newLine - 1);
      inHunk = true;
      continue;
    }
    if (!inHunk || !file) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      flushDeleted();
      const entry = ensure();
      if (entry) {
        entry.addedLines.push(newLine);
        entry.additions += 1;
      }
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-") && !raw.startsWith("---")) {
      curDeleted.push(raw.slice(1));
      continue;
    }
    if (raw.startsWith("\\")) continue;
    flushDeleted();
    newLine += 1;
  }
  flushDeleted();

  // For deleted files with no hunks captured, still register the file
  for (const [k, v] of out) {
    v.addedLines = [...new Set(v.addedLines)].filter((n) => n > 0).sort((a, b) => a - b);
    if (v.status === "added") v.entireFile = true;
    out.set(k, v);
  }
  return out;
}
