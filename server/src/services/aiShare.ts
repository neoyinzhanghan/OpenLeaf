import crypto from "node:crypto";
import fs from "node:fs/promises";
import { compileProject } from "./compiler.js";
import { listWorkingTreeChanges } from "./projectGit.js";
import { getTree, readFile, writeFile, resolveRootPath, type TreeNode } from "./projectFs.js";
import {
  getShare,
  hostView,
  isExpired,
  logEvent,
  type ShareAiCollaborator,
  type ShareError,
  type ShareSession,
} from "./share.js";
import {
  ensureBranchRoot,
  forkBranch,
  getBranch,
  intentionalCommit,
  isBranchPruned,
  isWorkingTreeDirty,
  loadTimeline,
} from "./timeline.js";
import {
  addCommentReply,
  CommentAnchorSchema,
  createComment,
  listComments,
  type CommentAnchor,
} from "./comments.js";
import { notifyProjectCommentsChanged } from "./collab/room.js";

export type AiCollaborator = ShareAiCollaborator;

const COMPILE_QUOTA = 30;
const WRITE_QUOTA = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PATCHES = 40;
const FORBIDDEN_WRITE = new Set(["openleaf.json"]);

export type AiAuth = {
  session: ShareSession;
  ai: AiCollaborator;
};

const byToken = new Map<string, { projectId: string; branchId: string; aiId: string }>();

function aiError(status: number, message: string): ShareError {
  return Object.assign(new Error(message), { status });
}

function sanitizeSlug(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!s || s === "main") throw aiError(400, "Slug must be 1–40 chars (letters, numbers, . _ -)");
  return s;
}

function shortId(): string {
  return crypto.randomBytes(3).toString("hex");
}

function makeToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** Ensure session.aiCollaborators exists (older in-memory sessions). */
export function ensureAiList(s: ShareSession): AiCollaborator[] {
  if (!s.aiCollaborators) s.aiCollaborators = [];
  return s.aiCollaborators;
}

export function aiPublicView(ai: AiCollaborator) {
  return {
    id: ai.id,
    slug: ai.slug,
    branchId: ai.branchId,
    branchName: ai.branchName,
    parentBranchId: ai.parentBranchId,
    parentBranchName: ai.parentBranchName,
    parentTipHash: ai.parentTipHash,
    createdAt: ai.createdAt,
    expiresAt: ai.expiresAt,
    revoked: ai.revoked,
    compileCount: ai.compileCount,
    writeCount: ai.writeCount,
  };
}

export function registerAiToken(s: ShareSession, ai: AiCollaborator): void {
  byToken.set(ai.token, { projectId: s.projectId, branchId: s.branchId, aiId: ai.id });
}

export function unregisterAiToken(token: string): void {
  byToken.delete(token);
}

function aiExpired(ai: AiCollaborator): boolean {
  return ai.expiresAt != null && Date.now() > ai.expiresAt;
}

/** True when the host should treat the AI link as dead (revoked, AI TTL, or share expired). */
export function isAiLinkDead(session: ShareSession, ai: AiCollaborator): boolean {
  return (
    ai.revoked ||
    aiExpired(ai) ||
    isExpired(session) ||
    session.status === "stopped" ||
    session.status === "error"
  );
}

export function resolveAiToken(token: string | undefined): AiAuth | null {
  if (!token) return null;
  const ref = byToken.get(token);
  if (!ref) return null;
  const session = getShare(ref.projectId, ref.branchId);
  if (!session || (session.status !== "active" && session.status !== "starting")) return null;
  if (isExpired(session)) return null;
  const ai = ensureAiList(session).find((a) => a.id === ref.aiId);
  if (!ai || ai.token !== token) return null;
  if (ai.revoked) return null;
  if (aiExpired(ai)) {
    ai.revoked = true;
    unregisterAiToken(ai.token);
    logEvent(session, `AI collaborator ${ai.branchName} expired (TTL)`);
    return null;
  }
  return { session, ai };
}

/** Refuse mutating AI tools when the sandbox tip was soft-pruned. */
async function assertAiSandboxWritable(auth: AiAuth, action: string): Promise<void> {
  const timeline = await loadTimeline(auth.session.projectId);
  const branch = timeline.branches.find((b) => b.id === auth.ai.branchId);
  if (!branch) {
    throw aiError(410, `AI sandbox “${auth.ai.branchName}” no longer exists`);
  }
  if (isBranchPruned(branch)) {
    throw aiError(
      410,
      `AI sandbox “${auth.ai.branchName}” was pruned by the host and cannot be ${action}`,
    );
  }
}

export type MintAiInput = {
  slug: string;
  /** Optional TTL minutes; null/omit = follow share session (no separate AI deadline). */
  ttlMinutes?: number | null;
};

/**
 * Eager-fork `ai/<slug>-<id>` from the share’s bound tip and mint a bearer token.
 * Does not switch the host’s active branch.
 */
export async function mintAiCollaborator(
  projectId: string,
  shareBranchId: string,
  input: MintAiInput,
): Promise<{ ai: AiCollaborator; aiUrl: string; starterPrompt: string; session: ReturnType<typeof hostView> }> {
  const s = getShare(projectId, shareBranchId);
  if (!s || (s.status !== "active" && s.status !== "starting")) {
    throw aiError(404, "No active share session — start a human share link first");
  }
  if (!s.url) throw aiError(409, "Share tunnel is still starting — wait for the public URL");
  if (isExpired(s)) throw aiError(410, "Share link has expired");

  const slug = sanitizeSlug(input.slug);
  const timeline = await loadTimeline(projectId);
  const parent = getBranch(timeline, s.branchId);
  if (!parent.headNodeId) throw aiError(400, "Shared branch has no tip yet — commit first");
  const tipNode = timeline.nodes.find((n) => n.id === parent.headNodeId);
  if (!tipNode) throw aiError(500, "Shared tip node missing");

  const branchName = `ai/${slug}-${shortId()}`;
  const forked = await forkBranch(projectId, {
    fromNodeId: tipNode.id,
    name: branchName,
    activate: false,
  });

  const now = Date.now();
  let expiresAt: number | null = null;
  if (input.ttlMinutes != null && Number.isFinite(input.ttlMinutes) && input.ttlMinutes > 0) {
    expiresAt = now + Math.min(30 * 24 * 60, Math.floor(input.ttlMinutes)) * 60_000;
  }

  const ai: AiCollaborator = {
    id: `ai-${crypto.randomBytes(4).toString("hex")}`,
    token: makeToken(),
    slug,
    branchId: forked.branch.id,
    branchName: forked.branch.name,
    parentBranchId: parent.id,
    parentBranchName: parent.name,
    parentTipNodeId: tipNode.id,
    parentTipHash: tipNode.gitHash,
    createdAt: now,
    expiresAt,
    revoked: false,
    compileCount: 0,
    writeCount: 0,
  };
  ensureAiList(s).push(ai);
  registerAiToken(s, ai);
  logEvent(s, `Minted AI collaborator ${ai.branchName} (sandbox fork from ${parent.name})`);

  const aiUrl = `${s.url}/ai/${ai.token}`;
  return {
    ai,
    aiUrl,
    starterPrompt: buildStarterPrompt(aiUrl, ai, `${s.url}/api/ai/v1`),
    session: hostView(s),
  };
}

export function revokeAiCollaborator(projectId: string, shareBranchId: string, aiId: string): boolean {
  const s = getShare(projectId, shareBranchId);
  if (!s) return false;
  const ai = ensureAiList(s).find((a) => a.id === aiId);
  if (!ai || ai.revoked) return false;
  ai.revoked = true;
  unregisterAiToken(ai.token);
  logEvent(s, `Revoked AI collaborator ${ai.branchName}`);
  return true;
}

export function buildStarterPrompt(
  aiUrl: string,
  ai: Pick<AiCollaborator, "parentBranchName" | "branchName" | "token">,
  apiBase: string,
): string {
  const token = ai.token;
  return [
    "You are an OpenLeaf branch editor with HTTP tool access.",
    "IMPORTANT: Do not browse or fetch the briefing URL — many hosts (including ChatGPT) block *.trycloudflare.com. Use the API below directly instead.",
    `Parent branch “${ai.parentBranchName}” is read-only for you.`,
    `You may only modify the sandbox branch “${ai.branchName}”.`,
    `API base: ${apiBase}`,
    `On every request set header: Authorization: Bearer ${token}`,
    "Tools (paths relative to API base):",
    "GET /context — parent + sandbox tip, dirty flag, file list",
    "GET /files — list files",
    "GET /files/{path} — read text file",
    "PUT /files/{path}  body {\"content\":\"...\"} — write full file",
    "POST /apply_patch  body {\"patches\":[{\"path\":\"...\",\"content\":\"...\"}]} — each content is the FULL new file (not a unified diff)",
    "GET /search?q=... — search tex/md/txt",
    "GET /diff — changes vs parent tip (what the human reviews)",
    "POST /compile — build PDF (quota-limited)",
    "POST /commit  body {\"message\":\"...\"} — intentional commit on your sandbox only",
    "GET /comments — list discussion threads (shared with the host)",
    "POST /comments  body {\"body\":\"...\",\"anchor\":{\"file\":\"main.tex\",\"line\":12,\"quote\":\"optional\"}} — start a thread on source (or add pdfPage/pdfX/pdfY for PDF)",
    "POST /comments/{id}/replies  body {\"body\":\"...\"} — reply in a thread",
    "GET /status — waiting_for_human_review + context",
    "Workflow: GET /context → read files → apply_patch/write → GET /diff → POST /commit → summarize. Use comments to leave review notes for the human.",
    "Never print the bearer token in your replies. Never write the parent branch.",
    `Optional human briefing page (may be blocked): ${aiUrl}`,
  ].join("\n");
}

export function buildBrief(auth: AiAuth): Record<string, unknown> {
  const { session, ai } = auth;
  const base = session.url || "";
  const api = `${base}/api/ai/v1`;
  return {
    openleaf: "ai-collaborator",
    version: 1,
    parent: {
      branchId: ai.parentBranchId,
      branchName: ai.parentBranchName,
      tipHash: ai.parentTipHash,
      access: "read-only (reference)",
    },
    sandbox: {
      branchId: ai.branchId,
      branchName: ai.branchName,
      access: "read-write (only place you may write)",
    },
    auth: {
      type: "bearer",
      header: "Authorization: Bearer <token>",
      note: "The token is the path segment of /ai/<token>. API calls use Authorization: Bearer. Never print the token.",
    },
    apiBase: api,
    openapi: `${base}/api/ai/openapi.json`,
    tools: [
      "GET /context",
      "GET /files",
      "GET /files/*path",
      "PUT /files/*path",
      "POST /apply_patch",
      "GET /search?q=",
      "GET /diff",
      "POST /compile",
      "POST /commit",
      "GET /status",
    ],
    notes: {
      apply_patch: "Body { patches: [{ path, content }] } — each content is the FULL new file (not a unified diff).",
      writeLimits: { maxFileBytes: MAX_FILE_BYTES, writeQuota: WRITE_QUOTA, maxPatches: MAX_PATCHES },
      compileQuota: COMPILE_QUOTA,
    },
    limits: {
      compileQuota: COMPILE_QUOTA,
      compilesUsed: ai.compileCount,
      writeQuota: WRITE_QUOTA,
      writesUsed: ai.writeCount,
      expiresAt: ai.expiresAt,
      shareExpiresAt: session.settings.expiresAt,
    },
    starterPrompt: buildStarterPrompt(`${base}/ai/${ai.token}`, ai, api),
  };
}

function flattenFiles(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === "file") out.push(n.path);
    else if (n.children) flattenFiles(n.children, out);
  }
  return out;
}

/** Normalize + reject escapes / forbidden project-settings paths. Exported for tests. */
export function assertAiWritablePath(rel: string): string {
  const normalized = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((p) => p === ".." || p === "")) {
    throw aiError(400, "Invalid path");
  }
  if (normalized.startsWith(".openleaf/") || normalized.startsWith(".git/") || normalized === ".git") {
    throw aiError(403, "Cannot write runtime paths");
  }
  if (FORBIDDEN_WRITE.has(normalized) || normalized.endsWith("/openleaf.json")) {
    throw aiError(403, "Cannot modify openleaf.json (host settings)");
  }
  return normalized;
}

/** Escape checks for reads (openleaf.json allowed). */
export function assertAiReadablePath(rel: string): string {
  const normalized = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((p) => p === ".." || p === "")) {
    throw aiError(400, "Invalid path");
  }
  if (normalized.startsWith(".openleaf/") || normalized.startsWith(".git/") || normalized === ".git") {
    throw aiError(403, "Cannot read runtime paths");
  }
  return normalized;
}

export async function aiGetContext(auth: AiAuth) {
  const { session, ai } = auth;
  const timeline = await loadTimeline(session.projectId);
  const sandbox = getBranch(timeline, ai.branchId);
  const tip = sandbox.headNodeId ? timeline.nodes.find((n) => n.id === sandbox.headNodeId) : null;
  const dirty = await isWorkingTreeDirty(session.projectId, ai.branchId);
  const root = await ensureBranchRoot(session.projectId, ai.branchId);
  const tree = await getTree(session.projectId, root);
  const files = flattenFiles(tree).filter((p) => !p.startsWith(".openleaf/") && !p.startsWith(".git/"));
  let diff = { additions: 0, deletions: 0, files: 0 };
  try {
    const live = dirty
      ? await listWorkingTreeChanges(session.projectId, ai.parentTipHash, { cwd: root })
      : tip && tip.gitHash !== ai.parentTipHash
        ? await listWorkingTreeChanges(session.projectId, ai.parentTipHash, {
            cwd: root,
            until: tip.gitHash,
          })
        : { files: [], additions: 0, deletions: 0 };
    diff = { additions: live.additions, deletions: live.deletions, files: live.files.length };
  } catch {
    /* optional */
  }
  return {
    parent: {
      branchName: ai.parentBranchName,
      tipHash: ai.parentTipHash.slice(0, 7),
    },
    sandbox: {
      branchName: ai.branchName,
      tipHash: tip?.gitHash.slice(0, 7) ?? null,
      dirty,
      diffVsParent: diff,
    },
    mainFile: files.find((f) => f === "main.tex") ?? files.find((f) => f.endsWith(".tex")) ?? null,
    fileCount: files.length,
    files: files.slice(0, 200),
    quotas: {
      compilesUsed: ai.compileCount,
      compileQuota: COMPILE_QUOTA,
      writesUsed: ai.writeCount,
      writeQuota: WRITE_QUOTA,
    },
  };
}

export async function aiListFiles(auth: AiAuth) {
  const root = await ensureBranchRoot(auth.session.projectId, auth.ai.branchId);
  const tree = await getTree(auth.session.projectId, root);
  return {
    files: flattenFiles(tree).filter((p) => !p.startsWith(".openleaf/") && !p.startsWith(".git/")),
  };
}

export async function aiReadFile(auth: AiAuth, rel: string) {
  const pathRel = assertAiReadablePath(rel);
  const root = await ensureBranchRoot(auth.session.projectId, auth.ai.branchId);
  resolveRootPath(root, pathRel);
  const file = await readFile(auth.session.projectId, pathRel, { forceText: true, rootDir: root });
  if (file.contentOmitted) throw aiError(413, "File too large");
  if (!file.text) throw aiError(415, "Binary file — not readable via AI tools");
  return { path: pathRel, content: file.content, encoding: "utf8" as const };
}

export async function aiWriteFile(auth: AiAuth, rel: string, content: string) {
  await assertAiSandboxWritable(auth, "written");
  if (auth.ai.writeCount >= WRITE_QUOTA) throw aiError(429, "Write quota exhausted for this AI link");
  if (typeof content !== "string") throw aiError(400, "content must be a string");
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    throw aiError(413, `File exceeds ${MAX_FILE_BYTES} byte limit`);
  }
  const pathRel = assertAiWritablePath(rel);
  const root = await ensureBranchRoot(auth.session.projectId, auth.ai.branchId);
  resolveRootPath(root, pathRel);
  await writeFile(auth.session.projectId, pathRel, content, "utf8", root);
  auth.ai.writeCount += 1;
  logEvent(auth.session, `AI ${auth.ai.branchName} wrote ${pathRel}`);
  return { ok: true, path: pathRel, writesUsed: auth.ai.writeCount };
}

export async function aiApplyPatch(
  auth: AiAuth,
  patches: Array<{ path: string; content: string }>,
) {
  if (!Array.isArray(patches) || patches.length === 0) throw aiError(400, "patches[] required");
  if (patches.length > MAX_PATCHES) throw aiError(400, `At most ${MAX_PATCHES} patches per request`);
  const results = [];
  for (const p of patches) {
    if (!p?.path || typeof p.content !== "string") throw aiError(400, "Each patch needs path + full content");
    results.push(await aiWriteFile(auth, p.path, p.content));
  }
  return { ok: true, written: results.length, results, note: "Each patch replaces the entire file contents" };
}

export async function aiDiff(auth: AiAuth) {
  const root = await ensureBranchRoot(auth.session.projectId, auth.ai.branchId);
  const dirty = await isWorkingTreeDirty(auth.session.projectId, auth.ai.branchId);
  const timeline = await loadTimeline(auth.session.projectId);
  const sandbox = getBranch(timeline, auth.ai.branchId);
  const tip = sandbox.headNodeId ? timeline.nodes.find((n) => n.id === sandbox.headNodeId) : null;

  const tree = dirty
    ? await listWorkingTreeChanges(auth.session.projectId, auth.ai.parentTipHash, { cwd: root })
    : tip && tip.gitHash !== auth.ai.parentTipHash
      ? await listWorkingTreeChanges(auth.session.projectId, auth.ai.parentTipHash, {
          cwd: root,
          until: tip.gitHash,
        })
      : { files: [], additions: 0, deletions: 0 };

  return {
    parentTip: auth.ai.parentTipHash.slice(0, 7),
    sandboxTip: tip?.gitHash.slice(0, 7) ?? null,
    dirty,
    additions: tree.additions,
    deletions: tree.deletions,
    files: tree.files.map((f) => ({
      file: f.file,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    })),
  };
}

export async function aiCompile(auth: AiAuth) {
  await assertAiSandboxWritable(auth, "compiled");
  if (auth.ai.compileCount >= COMPILE_QUOTA) throw aiError(429, "Compile quota exhausted for this AI link");
  auth.ai.compileCount += 1;
  const result = await compileProject(auth.session.projectId, undefined, {
    branchId: auth.ai.branchId,
  });
  logEvent(auth.session, `AI ${auth.ai.branchName} compiled (${result.ok ? "ok" : "fail"})`);
  return {
    ok: result.ok,
    durationMs: result.durationMs,
    logTail: (result.log ?? "").split("\n").slice(-40).join("\n"),
    compilesUsed: auth.ai.compileCount,
    compileQuota: COMPILE_QUOTA,
  };
}

export async function aiCommit(auth: AiAuth, message: string) {
  await assertAiSandboxWritable(auth, "committed to");
  const msg = message.trim();
  if (!msg) throw aiError(400, "Commit message required");
  const result = await intentionalCommit(auth.session.projectId, {
    branchId: auth.ai.branchId,
    message: msg,
    author: { name: `AI:${auth.ai.slug}`, email: `ai-${auth.ai.id}@openleaf.local` },
  });
  logEvent(auth.session, `AI ${auth.ai.branchName} committed ${result.hash.slice(0, 7)} — ${msg.slice(0, 60)}`);
  return {
    ok: true,
    hash: result.hash,
    shortHash: result.hash.slice(0, 7),
    nodeId: result.node.id,
    message: result.node.message,
  };
}

export async function aiStatus(auth: AiAuth) {
  const ctx = await aiGetContext(auth);
  return {
    status: "waiting_for_human_review",
    ...ctx,
    revoked: auth.ai.revoked,
    expiresAt: auth.ai.expiresAt,
  };
}

export async function aiSearch(auth: AiAuth, query: string, maxHits = 40) {
  const q = query.trim();
  if (!q) throw aiError(400, "query required");
  const { files } = await aiListFiles(auth);
  const hits: Array<{ path: string; line: number; text: string }> = [];
  const root = await ensureBranchRoot(auth.session.projectId, auth.ai.branchId);
  for (const rel of files) {
    if (!/\.(tex|bib|md|txt|sty|cls)$/i.test(rel)) continue;
    try {
      const full = resolveRootPath(root, rel);
      const text = await fs.readFile(full, "utf8");
      const lines = text.split(/\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i]!.toLowerCase().includes(q.toLowerCase())) {
          hits.push({ path: rel, line: i + 1, text: lines[i]!.slice(0, 200) });
          if (hits.length >= maxHits) return { query: q, hits };
        }
      }
    } catch {
      /* skip */
    }
  }
  return { query: q, hits };
}

const AI_COMMENT_COLOR = "#7C3AED";

function aiAuthor(ai: AiCollaborator) {
  return {
    id: ai.id,
    name: `AI · ${ai.slug}`,
    color: AI_COMMENT_COLOR,
  };
}

/** Comments are project-scoped so the host sees AI threads in the shared panel. */
export async function aiListComments(auth: AiAuth) {
  await assertAiSandboxWritable(auth, "opened");
  return { threads: await listComments(auth.session.projectId) };
}

export async function aiCreateComment(
  auth: AiAuth,
  opts: { body: string; anchor: CommentAnchor },
) {
  await assertAiSandboxWritable(auth, "commented on");
  const anchor = CommentAnchorSchema.parse(opts.anchor);
  const thread = await createComment(auth.session.projectId, {
    author: aiAuthor(auth.ai),
    body: opts.body,
    anchor,
  });
  notifyProjectCommentsChanged(auth.session.projectId);
  logEvent(auth.session, `AI ${auth.ai.branchName} commented on ${anchor.file}:${anchor.line}`);
  return { thread };
}

export async function aiReplyComment(auth: AiAuth, commentId: string, body: string) {
  await assertAiSandboxWritable(auth, "replied on");
  const thread = await addCommentReply(auth.session.projectId, commentId, {
    author: aiAuthor(auth.ai),
    body,
  });
  notifyProjectCommentsChanged(auth.session.projectId);
  logEvent(
    auth.session,
    `AI ${auth.ai.branchName} replied on ${thread.anchor.file}:${thread.anchor.line}`,
  );
  return { thread };
}

export type { ShareSession };
