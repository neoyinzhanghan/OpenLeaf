import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { projectDir } from "../projectFs.js";
import { ensureProjectGit } from "../projectGit.js";
import { loadTimeline } from "../timeline.js";
import { AGENT_CONTEXT_DIR, AGENT_CONTEXT_SCHEMA_VERSION, isAgentContextRel } from "./constants.js";
import { CAPSULE_USAGE, type CapsuleCheck, type CapsuleDecision } from "./capsule.js";

const execFileAsync = promisify(execFile);
const HASH_RE = /^[0-9a-f]{7,40}$/i;
const MAX_CAPSULE_BYTES = 256 * 1024;

function err(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

export type AgentContextTurn = {
  schemaVersion: number;
  kind: "agent-context";
  usage: typeof CAPSULE_USAGE;
  shareStatus: "auto";
  conversationId: string;
  generationId: string;
  writtenAt: string;
  capsulePath: string;
  baseCommit: string | null;
  diffDigest: string | null;
  objective: string | null;
  outcome: string | null;
  decisions: CapsuleDecision[];
  changedFiles: string[];
  verification: CapsuleCheck[];
  assumptions: string[];
  openQuestions: string[];
  nextSteps: string[];
};

export type AgentContextSession = {
  conversationId: string;
  startedAt: string | null;
  turnCount: number;
  turns: AgentContextTurn[];
};

export type AgentContextCommit = {
  nodeId: string | null;
  gitHash: string;
  shortHash: string;
  message: string;
  author: string;
  createdAt: string;
};

export type AgentContextView = {
  commit: AgentContextCommit;
  sessions: AgentContextSession[];
  skipped: number;
};

async function runGit(
  projectId: string,
  args: string[],
  opts?: { allowFailure?: boolean; encoding?: "utf8" | "buffer" },
): Promise<{ stdout: Buffer | string; stderr: string; code: number }> {
  const cwd = projectDir(projectId);
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: 30_000,
      maxBuffer: MAX_CAPSULE_BYTES + 64 * 1024,
      encoding: opts?.encoding === "buffer" ? "buffer" : "utf8",
    } as Parameters<typeof execFileAsync>[2]);
    return { stdout, stderr: String(stderr), code: 0 };
  } catch (e) {
    const ex = e as { stdout?: Buffer | string; stderr?: string; code?: number; message?: string };
    if (opts?.allowFailure) {
      return {
        stdout: ex.stdout ?? "",
        stderr: String(ex.stderr ?? ex.message ?? ""),
        code: typeof e === "object" && e && "code" in e && typeof ex.code === "number" ? ex.code : 1,
      };
    }
    throw err(500, ex.stderr || ex.message || "git failed");
  }
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function asStringList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (!t) continue;
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

function asDecisions(v: unknown): CapsuleDecision[] {
  if (!Array.isArray(v)) return [];
  const out: CapsuleDecision[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const statement = asString((item as { statement?: unknown }).statement);
    if (!statement) continue;
    const rationale = asString((item as { rationale?: unknown }).rationale);
    out.push(rationale ? { statement, rationale } : { statement });
    if (out.length >= 8) break;
  }
  return out;
}

function asChecks(v: unknown): CapsuleCheck[] {
  if (!Array.isArray(v)) return [];
  const out: CapsuleCheck[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const check = asString((item as { check?: unknown }).check);
    const status = (item as { status?: unknown }).status;
    if (!check) continue;
    if (status !== "passed" && status !== "failed" && status !== "error" && status !== "unknown") continue;
    out.push({ check, status });
    if (out.length >= 20) break;
  }
  return out;
}

/** Pick only the shareable allowlist. Reject trajectory-shaped or invalid blobs. */
export function parseAgentContextCapsule(raw: unknown, capsulePath: string): AgentContextTurn | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== "agent-context") return null;
  if (typeof o.schemaVersion !== "number" || !Number.isFinite(o.schemaVersion)) return null;
  if ("payload" in o || "hook" in o || "prevHash" in o) return null;
  const conversationId = asString(o.conversationId);
  const generationId = asString(o.generationId);
  if (!conversationId || !generationId) return null;
  const writtenAt = asString(o.writtenAt) ?? "";
  return {
    schemaVersion: o.schemaVersion === AGENT_CONTEXT_SCHEMA_VERSION ? AGENT_CONTEXT_SCHEMA_VERSION : o.schemaVersion,
    kind: "agent-context",
    usage: CAPSULE_USAGE,
    shareStatus: "auto",
    conversationId,
    generationId,
    writtenAt,
    capsulePath,
    baseCommit: asString(o.baseCommit),
    diffDigest: asString(o.diffDigest),
    objective: asString(o.objective),
    outcome: asString(o.outcome),
    decisions: asDecisions(o.decisions),
    changedFiles: asStringList(o.changedFiles, 40),
    verification: asChecks(o.verification),
    assumptions: asStringList(o.assumptions, 8),
    openQuestions: asStringList(o.openQuestions, 8),
    nextSteps: asStringList(o.nextSteps, 8),
  };
}

export function groupTurnsBySession(turns: AgentContextTurn[]): AgentContextSession[] {
  const byConv = new Map<string, AgentContextTurn[]>();
  for (const turn of turns) {
    const list = byConv.get(turn.conversationId) ?? [];
    list.push(turn);
    byConv.set(turn.conversationId, list);
  }
  const sessions: AgentContextSession[] = [];
  for (const [conversationId, list] of byConv) {
    list.sort((a, b) => a.writtenAt.localeCompare(b.writtenAt) || a.generationId.localeCompare(b.generationId));
    sessions.push({
      conversationId,
      startedAt: list[0]?.writtenAt || null,
      turnCount: list.length,
      turns: list,
    });
  }
  sessions.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.conversationId.localeCompare(b.conversationId));
  return sessions;
}

function isCapsuleJsonRel(rel: string): boolean {
  const n = rel.replace(/\\/g, "/");
  if (!isAgentContextRel(n)) return false;
  if (!n.endsWith(".json")) return false;
  if (n.includes("..")) return false;
  return n.startsWith(`${AGENT_CONTEXT_DIR}/`);
}

async function addedCapsulePaths(projectId: string, gitHash: string): Promise<string[]> {
  const listed = await runGit(
    projectId,
    ["diff-tree", "--root", "--no-commit-id", "--name-only", "--diff-filter=A", "-r", gitHash],
    { allowFailure: true },
  );
  if (listed.code !== 0) throw err(404, "Commit not found");
  return String(listed.stdout)
    .split("\n")
    .map((l) => l.trim().replace(/\\/g, "/"))
    .filter(isCapsuleJsonRel);
}

async function readCommitBlob(projectId: string, gitHash: string, rel: string): Promise<string | null> {
  const probe = await runGit(projectId, ["cat-file", "-s", `${gitHash}:${rel}`], { allowFailure: true });
  if (probe.code !== 0) return null;
  const size = Number(String(probe.stdout).trim()) || 0;
  if (size <= 0 || size > MAX_CAPSULE_BYTES) return null;
  const blob = await runGit(projectId, ["cat-file", "-p", `${gitHash}:${rel}`], {
    allowFailure: true,
    encoding: "buffer",
  });
  if (blob.code !== 0) return null;
  const buf = Buffer.isBuffer(blob.stdout) ? blob.stdout : Buffer.from(String(blob.stdout));
  return buf.toString("utf8");
}

async function resolveCommit(
  projectId: string,
  opts: { nodeId?: string; gitHash?: string },
): Promise<AgentContextCommit> {
  const state = await loadTimeline(projectId);
  if (opts.nodeId) {
    const node = state.nodes.find((n) => n.id === opts.nodeId);
    if (!node) throw err(404, "Timeline leaf not found");
    return {
      nodeId: node.id,
      gitHash: node.gitHash,
      shortHash: node.gitHash.slice(0, 7),
      message: node.message,
      author: node.author,
      createdAt: node.createdAt,
    };
  }
  const raw = (opts.gitHash ?? "").trim();
  if (!HASH_RE.test(raw)) throw err(400, "Invalid commit hash");
  const verified = await runGit(projectId, ["rev-parse", "--verify", `${raw}^{commit}`], { allowFailure: true });
  if (verified.code !== 0) throw err(404, "Commit not found");
  const gitHash = String(verified.stdout).trim();
  const node =
    state.nodes.find((n) => n.gitHash === gitHash) ??
    state.nodes.find((n) => n.gitHash.startsWith(raw) || gitHash.startsWith(n.gitHash));
  if (node) {
    return {
      nodeId: node.id,
      gitHash: node.gitHash,
      shortHash: node.gitHash.slice(0, 7),
      message: node.message,
      author: node.author,
      createdAt: node.createdAt,
    };
  }
  const meta = await runGit(
    projectId,
    ["log", "-1", "--format=%H%n%an%n%aI%n%s", gitHash],
    { allowFailure: true },
  );
  const [full, author, createdAt, ...msg] = String(meta.stdout).split("\n");
  return {
    nodeId: null,
    gitHash: full?.trim() || gitHash,
    shortHash: (full?.trim() || gitHash).slice(0, 7),
    message: msg.join("\n").trim(),
    author: author?.trim() || "OpenLeaf",
    createdAt: createdAt?.trim() || new Date().toISOString(),
  };
}

export async function listAgentSessionsAtCommit(
  projectId: string,
  opts: { nodeId?: string; gitHash?: string },
): Promise<AgentContextView> {
  if (!opts.nodeId && !opts.gitHash) throw err(400, "Provide nodeId or commit");
  await ensureProjectGit(projectId);
  const commit = await resolveCommit(projectId, opts);
  const paths = await addedCapsulePaths(projectId, commit.gitHash);
  const turns: AgentContextTurn[] = [];
  let skipped = 0;
  for (const rel of paths) {
    const text = await readCommitBlob(projectId, commit.gitHash, rel);
    if (!text) {
      skipped += 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      skipped += 1;
      continue;
    }
    const turn = parseAgentContextCapsule(parsed, rel);
    if (!turn) {
      skipped += 1;
      continue;
    }
    turns.push(turn);
  }
  return {
    commit,
    sessions: groupTurnsBySession(turns),
    skipped,
  };
}
