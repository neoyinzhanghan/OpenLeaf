import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../config.js";
import { projectDir, resolveProjectPath } from "./projectFs.js";

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
  opts?: { author?: GitAuthor; allowFailure?: boolean },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cwd = projectDir(id);
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
 * Stage all tracked/untracked source files and commit if there are changes.
 * Safe to call after every save/flush.
 */
export async function autoCommitProject(
  id: string,
  opts?: { message?: string; author?: GitAuthor },
): Promise<GitCommitResult> {
  if (!isGitEnabled()) {
    return { committed: false, hash: null, message: "", skipped: "disabled" };
  }

  try {
    await ensureProjectGit(id);
    await runGit(id, ["add", "-A"]);

    const status = await runGit(id, ["status", "--porcelain"], { allowFailure: true });
    if (!status.stdout.trim()) {
      return { committed: false, hash: null, message: "", skipped: "clean" };
    }

    const message = defaultMessage(opts?.message);
    const commit = await runGit(
      id,
      ["commit", "-m", message, "--no-gpg-sign"],
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

/**
 * Source lines added in manuscript .tex files since `since` (working tree vs that commit).
 * Skips `misc/`, comments, and blank lines.
 */
export async function listAddedManuscriptLines(
  id: string,
  since: string,
): Promise<AddedTexLines[]> {
  if (!isGitEnabled()) return [];
  if (!HASH_RE.test(since)) {
    throw Object.assign(new Error("Invalid commit hash"), { status: 400 });
  }
  await ensureProjectGit(id);

  const verify = await runGit(id, ["cat-file", "-t", since], { allowFailure: true });
  if (verify.code !== 0 || !verify.stdout.includes("commit")) {
    throw Object.assign(new Error("Commit not found"), { status: 404 });
  }

  const diff = await runGit(
    id,
    ["diff", "-U0", "--find-renames", "--diff-filter=ACMR", since],
    { allowFailure: true },
  );

  const { byFile, newFiles } = parseAddedLinesFromUnifiedDiff(diff.stdout);

  const untracked = await runGit(id, ["ls-files", "--others", "--exclude-standard"], {
    allowFailure: true,
  });
  for (const rel of untracked.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (!isManuscriptTexPath(rel) || byFile.has(rel)) continue;
    try {
      const full = resolveProjectPath(id, rel);
      const text = await fs.readFile(full, "utf8");
      const lines: number[] = [];
      const raw = text.split(/\n/);
      for (let i = 0; i < raw.length; i += 1) {
        if (isHighlightableTexLine(raw[i] ?? "")) lines.push(i + 1);
      }
      if (lines.length) {
        byFile.set(rel, lines);
        newFiles.add(rel);
      }
    } catch {
      /* ignore unreadable */
    }
  }

  const out: AddedTexLines[] = [];
  for (const [file, lines] of byFile) {
    if (!isManuscriptTexPath(file)) continue;
    const unique = [...new Set(lines)].filter((n) => n > 0).sort((a, b) => a - b);
    const entireFile = newFiles.has(file);
    if (unique.length || entireFile) out.push({ file, lines: unique, entireFile });
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

/** Exported for tests / reuse. */
export function parseAddedLinesFromUnifiedDiff(diff: string): ParsedAddedDiff {
  const byFile = new Map<string, number[]>();
  const newFiles = new Set<string>();
  let file: string | null = null;
  let newLine = 0;
  let inHunk = false;
  let pendingNew = false;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      file = null;
      inHunk = false;
      pendingNew = false;
      continue;
    }
    if (raw.startsWith("new file mode") || raw === "--- /dev/null") {
      pendingNew = true;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const spec = (raw.slice(4).split("\t")[0] ?? "").trim().replace(/^"|"$/g, "");
      if (spec === "/dev/null") {
        file = null;
        inHunk = false;
        pendingNew = false;
        continue;
      }
      file = spec.replace(/^[ab]\//, "");
      if (pendingNew && file) newFiles.add(file);
      pendingNew = false;
      continue;
    }
    const hunk = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !file) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      if (isHighlightableTexLine(raw.slice(1))) {
        const list = byFile.get(file) ?? [];
        list.push(newLine);
        byFile.set(file, list);
      }
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-") && !raw.startsWith("---")) continue;
    if (raw.startsWith("\\")) continue;
    newLine += 1;
  }
  return { byFile, newFiles };
}
