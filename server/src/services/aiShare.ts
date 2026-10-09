import crypto from "node:crypto";
import fs from "node:fs/promises";
import { compileProject } from "./compiler.js";
import { listWorkingTreeChanges } from "./projectGit.js";
import {
  deletePath,
  getTree,
  isProtectedAccessPath,
  normalizeAccessPath,
  MAX_TEXT_FILE_BYTES,
  readFile,
  writeFile,
  resolveRootPath,
  type TreeNode,
} from "./projectFs.js";
import { type ShareError } from "./share.js";
import { buildMcpConfigJson, buildStarterPrompt, mcpUrlFromApiBase } from "./aiPrompt.js";
import {
  ensureAiGateway,
  gatewayPublicView,
  getAiGateway,
  localhostOrigin,
  stopAiGateway,
} from "./aiGateway.js";
import {
  clearAiReview,
  listAiReview,
  reviewCtxFromAi,
  snapshotBeforeWrite,
  type ReviewCtx,
} from "./aiReview.js";
import {
  ingestProjectDiskPaths,
  notifyProjectAiReview,
  notifyProjectCommentsChanged,
  notifyProjectTreeChange,
} from "./collab/room.js";
import {
  applyFilePatches,
  hasCrlf,
  normalizeLf,
  parseUnifiedDiff,
  PatchError,
  replaceAllSubstrings,
  replaceLineRange,
  replaceUnique,
  sliceLines,
  toCrlf,
  toLines,
} from "./textPatch.js";
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

export type AiMintedBy =
  | { kind: "host" }
  | { kind: "guest"; guestId: string; guestName: string };

/** Guests may only revoke links they minted on the leaf their share is bound to. Hosts always may. */
export function guestMayRevokeAi(
  guestId: string,
  boundBranchId: string,
  ai: { parentBranchId: string; mintedBy: AiMintedBy },
): { ok: true } | { ok: false; error: string } {
  if (ai.parentBranchId !== boundBranchId) {
    return { ok: false, error: "You can only revoke AI links on the leaf this share grants you" };
  }
  if (ai.mintedBy.kind !== "guest" || ai.mintedBy.guestId !== guestId) {
    return { ok: false, error: "You can only revoke AI links you created" };
  }
  return { ok: true };
}

export type AiCollaborator = {
  id: string;
  token: string;
  slug: string;
  projectId: string;
  branchId: string;
  branchName: string;
  parentBranchId: string;
  parentBranchName: string;
  parentTipNodeId: string;
  parentTipHash: string;
  createdAt: number;
  expiresAt: number | null;
  revoked: boolean;
  compileCount: number;
  writeCount: number;
  mintedBy: AiMintedBy;
};

const COMPILE_QUOTA = 30;
const WRITE_QUOTA = 200;
const MAX_FILE_BYTES = MAX_TEXT_FILE_BYTES;
const MAX_PATCHES = 40;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
export { buildStarterPrompt } from "./aiPrompt.js";

function asAiError(err: unknown): never {
  if (err instanceof PatchError) {
    throw Object.assign(new Error(err.message), { status: err.status, code: err.code });
  }
  throw err;
}

export type AiAuth = {
  projectId: string;
  ai: AiCollaborator;
  publicUrl: string;
};

const collaborators = new Map<string, AiCollaborator>();
const byToken = new Map<string, string>();
const byProject = new Map<string, Set<string>>();

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

function indexAi(ai: AiCollaborator): void {
  collaborators.set(ai.id, ai);
  byToken.set(ai.token, ai.id);
  let set = byProject.get(ai.projectId);
  if (!set) {
    set = new Set();
    byProject.set(ai.projectId, set);
  }
  set.add(ai.id);
}

function unindexAi(_ai: AiCollaborator): void {
  /* reserved: live records stay indexed after revoke so the host can still see them until restart */
}

function publicUrlFor(projectId: string): string {
  return getAiGateway(projectId)?.url || localhostOrigin();
}

function logAi(ai: AiCollaborator, text: string): void {
  console.log(`[ai] ${ai.projectId}/${ai.branchName}: ${text}`);
}

function maybeStopIdleGateway(projectId: string): void {
  if (listLiveAi(projectId).length > 0) return;
  stopAiGateway(projectId);
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

export function registerAiToken(ai: AiCollaborator): void {
  byToken.set(ai.token, ai.id);
}

export function unregisterAiToken(token: string): void {
  byToken.delete(token);
}

function aiExpired(ai: AiCollaborator): boolean {
  return ai.expiresAt != null && Date.now() > ai.expiresAt;
}

/** True when the host should treat the AI link as dead (revoked or AI TTL). */
export function isAiLinkDead(ai: AiCollaborator): boolean {
  return ai.revoked || aiExpired(ai);
}

export function listAiForProject(projectId: string): AiCollaborator[] {
  const ids = byProject.get(projectId);
  if (!ids) return [];
  const out: AiCollaborator[] = [];
  for (const id of ids) {
    const ai = collaborators.get(id);
    if (ai) out.push(ai);
  }
  return out;
}

export function listLiveAi(projectId: string): AiCollaborator[] {
  return listAiForProject(projectId).filter((ai) => {
    if (aiExpired(ai) && !ai.revoked) {
      ai.revoked = true;
      unregisterAiToken(ai.token);
      logAi(ai, "expired (TTL)");
    }
    return !isAiLinkDead(ai);
  });
}

export function resolveAiToken(token: string | undefined): AiAuth | null {
  if (!token) return null;
  const aiId = byToken.get(token);
  if (!aiId) return null;
  const ai = collaborators.get(aiId);
  if (!ai || ai.token !== token) return null;
  if (ai.revoked) return null;
  if (aiExpired(ai)) {
    ai.revoked = true;
    unregisterAiToken(ai.token);
    logAi(ai, "expired (TTL)");
    maybeStopIdleGateway(ai.projectId);
    return null;
  }
  return { projectId: ai.projectId, ai, publicUrl: publicUrlFor(ai.projectId) };
}

/** Refuse mutating AI tools when the sandbox tip was soft-pruned. */
async function assertAiSandboxWritable(auth: AiAuth, action: string): Promise<void> {
  const timeline = await loadTimeline(auth.projectId);
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
  /** Optional TTL minutes; null/omit = no separate AI deadline. */
  ttlMinutes?: number | null;
  /** Fork from this leaf; omit to use the parent branch tip. */
  fromNodeId?: string | null;
  mintedBy?: AiMintedBy;
};

/**
 * Eager-fork `ai/<slug>-<id>` from the given parent leaf. Does not require a
 * human share session. Does not switch the host’s active branch.
 */
export async function mintAiCollaborator(
  projectId: string,
  parentBranchId: string,
  input: MintAiInput,
): Promise<{
  ai: AiCollaborator;
  aiUrl: string;
  starterPrompt: string;
  mcpUrl: string;
  mcpConfig: string;
  gateway: ReturnType<typeof gatewayPublicView>;
}> {
  const slug = sanitizeSlug(input.slug);
  if (parentBranchId.startsWith("ai/") || parentBranchId === "ai") {
    throw aiError(400, "AI links fork from a human leaf — switch off the AI sandbox first");
  }

  const timeline = await loadTimeline(projectId);
  const parent = getBranch(timeline, parentBranchId);
  if (!parent) throw aiError(404, "Parent branch not found");
  if (parent.name.startsWith("ai/")) {
    throw aiError(400, "AI links fork from a human leaf — switch off the AI sandbox first");
  }
  if (isBranchPruned(parent)) {
    throw aiError(410, `Tip “${parent.name}” was pruned and cannot host an AI link`);
  }
  if (!parent.headNodeId) throw aiError(400, "This leaf has no tip yet — commit first");

  const fromNodeId = input.fromNodeId || parent.headNodeId;
  const tipNode = timeline.nodes.find((n) => n.id === fromNodeId);
  if (!tipNode) throw aiError(400, "That leaf no longer exists");
  if (tipNode.branchId !== parent.id) {
    throw aiError(400, "That checkpoint is not on the leaf you are minting from");
  }

  const gateway = await ensureAiGateway(projectId);
  const origin = gateway.url || localhostOrigin();

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
    projectId,
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
    mintedBy: input.mintedBy ?? { kind: "host" },
  };
  indexAi(ai);
  logAi(ai, `minted sandbox from ${parent.name}@${tipNode.gitHash.slice(0, 7)}`);

  const aiUrl = `${origin}/ai/${ai.token}`;
  const apiBase = `${origin}/api/ai/v1`;
  const mcpUrl = mcpUrlFromApiBase(apiBase);
  return {
    ai,
    aiUrl,
    starterPrompt: buildStarterPrompt(aiUrl, ai, apiBase),
    mcpUrl,
    mcpConfig: buildMcpConfigJson({ mcpUrl, token: ai.token, slug: ai.slug }),
    gateway: gatewayPublicView(gateway),
  };
}

export function revokeAiCollaborator(projectId: string, aiId: string): boolean {
  const ai = collaborators.get(aiId);
  if (!ai || ai.projectId !== projectId || ai.revoked) return false;
  ai.revoked = true;
  unregisterAiToken(ai.token);
  clearAiReview(ai.id);
  logAi(ai, "revoked");
  maybeStopIdleGateway(projectId);
  return true;
}

export function hostAiView(ai: AiCollaborator) {
  const dead = isAiLinkDead(ai);
  const origin = publicUrlFor(ai.projectId);
  const aiUrl = dead || !origin ? null : `${origin}/ai/${ai.token}`;
  const apiBase = origin ? `${origin}/api/ai/v1` : "";
  const mcpUrl = dead || !origin ? null : mcpUrlFromApiBase(apiBase);
  return {
    ...aiPublicView(ai),
    mintedBy: ai.mintedBy,
    token: dead ? null : ai.token,
    aiUrl,
    starterPrompt: aiUrl == null || dead ? null : buildStarterPrompt(aiUrl, ai, apiBase),
    mcpUrl,
    mcpConfig:
      mcpUrl && !dead ? buildMcpConfigJson({ mcpUrl, token: ai.token, slug: ai.slug }) : null,
  };
}

export function listProjectAiLinks(projectId: string, parentBranchId?: string) {
  return {
    gateway: gatewayPublicView(getAiGateway(projectId)),
    collaborators: listAiForProject(projectId)
      .filter((ai) => !ai.revoked)
      .filter((ai) => !parentBranchId || ai.parentBranchId === parentBranchId)
      .map(hostAiView),
  };
}

export function buildBrief(auth: AiAuth): Record<string, unknown> {
  const { ai, publicUrl } = auth;
  const base = publicUrl || "";
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
    mcpUrl: mcpUrlFromApiBase(api),
    mcp: "Streamable HTTP JSON-RPC (initialize, tools/list, tools/call). Same Bearer token.",
    openapi: `${base}/api/ai/openapi.json`,
    tools: [
      "GET /context",
      "GET /files",
      "GET /files/*path",
      "POST /edit",
      "POST /edit_range",
      "POST /apply_diff",
      "PUT /files/*path",
      "POST /apply_patch",
      "GET /review",
      "GET /search?q=",
      "GET /diff",
      "POST /compile",
      "POST /commit",
      "GET /status",
    ],
    notes: {
      edit: "Body { path, old, new, replace_all? } — unique substring replace. Prefer this over rewriting a whole file.",
      edit_range: "Body { path, startLine, endLine, content } — inclusive 1-indexed line span. endLine = startLine-1 inserts.",
      apply_diff: "Body { diff } — unified diff; rejected if context does not match.",
      apply_patch: "Last resort. Body { patches: [{ path, content }] } — each content is the FULL new file (not a unified diff).",
      filesGet: "Optional query from=&to= for a 1-indexed inclusive line slice.",
      writeLimits: { maxFileBytes: MAX_FILE_BYTES, writeQuota: WRITE_QUOTA, maxPatches: MAX_PATCHES, maxDiffBytes: MAX_DIFF_BYTES },
      compileQuota: COMPILE_QUOTA,
    },
    limits: {
      compileQuota: COMPILE_QUOTA,
      compilesUsed: ai.compileCount,
      writeQuota: WRITE_QUOTA,
      writesUsed: ai.writeCount,
      expiresAt: ai.expiresAt,
      shareExpiresAt: null,
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

/** Normalize + reject escapes / protected paths. Policy for a project lives in assertCanWrite. */
export function assertAiWritablePath(rel: string): string {
  let normalized: string;
  try {
    normalized = normalizeAccessPath(rel);
  } catch {
    throw aiError(400, "Invalid path");
  }
  if (!normalized) throw aiError(400, "Invalid path");
  if (!isProtectedAccessPath(normalized)) return normalized;
  const lower = normalized.toLowerCase();
  if (lower === "openleaf.json" || lower.endsWith("/openleaf.json")) {
    throw aiError(403, "Cannot modify openleaf.json (host settings)");
  }
  if (lower === ".openleaf" || lower.startsWith(".openleaf/") || lower === ".git" || lower.startsWith(".git/")) {
    throw aiError(403, "Cannot write runtime paths");
  }
  throw aiError(403, "Cannot write this path");
}

async function assertAiCanWrite(projectId: string, rel: string): Promise<string> {
  const pathRel = assertAiWritablePath(rel);
  const { assertCanWrite } = await import("./fileAccess.js");
  try {
    await assertCanWrite(projectId, pathRel, "ai");
  } catch (err) {
    const status =
      err && typeof err === "object" && "status" in err ? (err as { status: number }).status : 403;
    throw aiError(status, err instanceof Error ? err.message : "Cannot write this path");
  }
  return pathRel;
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
  const { projectId, ai } = auth;
  const timeline = await loadTimeline(projectId);
  const sandbox = getBranch(timeline, ai.branchId);
  const tip = sandbox.headNodeId ? timeline.nodes.find((n) => n.id === sandbox.headNodeId) : null;
  const dirty = await isWorkingTreeDirty(projectId, ai.branchId);
  const root = await ensureBranchRoot(projectId, ai.branchId);
  const tree = await getTree(projectId, root);
  const files = flattenFiles(tree).filter((p) => !p.startsWith(".openleaf/") && !p.startsWith(".git/"));
  let diff = { additions: 0, deletions: 0, files: 0 };
  try {
    const live = dirty
      ? await listWorkingTreeChanges(projectId, ai.parentTipHash, { cwd: root })
      : tip && tip.gitHash !== ai.parentTipHash
        ? await listWorkingTreeChanges(projectId, ai.parentTipHash, {
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
  const root = await ensureBranchRoot(auth.projectId, auth.ai.branchId);
  const tree = await getTree(auth.projectId, root);
  return {
    files: flattenFiles(tree).filter((p) => !p.startsWith(".openleaf/") && !p.startsWith(".git/")),
  };
}

export async function aiReadFile(
  auth: AiAuth,
  rel: string,
  range?: { from?: number; to?: number },
) {
  const pathRel = assertAiReadablePath(rel);
  const root = await ensureBranchRoot(auth.projectId, auth.ai.branchId);
  resolveRootPath(root, pathRel);
  const file = await readFile(auth.projectId, pathRel, {
    forceText: true,
    rootDir: root,
    maxBytes: MAX_FILE_BYTES,
  });
  if (file.contentOmitted) throw aiError(413, "File too large");
  if (!file.text) throw aiError(415, "Binary file — not readable via AI tools");
  const content = normalizeLf(file.content);
  const totalLines = toLines(content).lines.length;
  if (range && (range.from != null || range.to != null)) {
    const sliced = sliceLines(content, range.from, range.to);
    return {
      path: pathRel,
      content: sliced.content,
      encoding: "utf8" as const,
      from: sliced.from,
      to: sliced.to,
      totalLines: sliced.totalLines,
      truncated: sliced.truncated,
    };
  }
  return { path: pathRel, content, encoding: "utf8" as const, totalLines, truncated: false };
}

async function readSandboxText(auth: AiAuth, pathRel: string): Promise<string | null> {
  const root = await ensureBranchRoot(auth.projectId, auth.ai.branchId);
  try {
    resolveRootPath(root, pathRel);
    const file = await readFile(auth.projectId, pathRel, {
      forceText: true,
      rootDir: root,
      maxBytes: MAX_FILE_BYTES,
    });
    if (file.contentOmitted) throw aiError(413, "File too large");
    if (!file.text) throw aiError(415, "Binary file — not readable via AI tools");
    return file.content;
  } catch (err) {
    const status =
      err && typeof err === "object" && "status" in err ? (err as { status: number }).status : 0;
    if (status === 404) return null;
    throw err;
  }
}

async function commitSandboxWrite(
  auth: AiAuth,
  pathRel: string,
  next: string,
  before: string | null,
): Promise<{ ok: true; path: string; writesUsed: number }> {
  await assertAiSandboxWritable(auth, "written");
  if (auth.ai.writeCount >= WRITE_QUOTA) throw aiError(429, "Write quota exhausted for this AI link");
  if (typeof next !== "string") throw aiError(400, "content must be a string");
  const nextLf = normalizeLf(next);
  const beforeLf = before == null ? null : normalizeLf(before);
  if (beforeLf !== null && beforeLf === nextLf) {
    return { ok: true, path: pathRel, writesUsed: auth.ai.writeCount };
  }
  if (Buffer.byteLength(nextLf, "utf8") > MAX_FILE_BYTES) {
    throw aiError(413, `File exceeds ${MAX_FILE_BYTES} byte limit`);
  }
  snapshotBeforeWrite(auth.ai.id, pathRel, before);
  const root = await ensureBranchRoot(auth.projectId, auth.ai.branchId);
  resolveRootPath(root, pathRel);
  const disk = before != null && hasCrlf(before) ? toCrlf(nextLf) : nextLf;
  await writeFile(auth.projectId, pathRel, disk, "utf8", root);
  auth.ai.writeCount += 1;
  logAi(auth.ai, `wrote ${pathRel}`);
  try {
    await ingestProjectDiskPaths(auth.projectId, [pathRel], auth.ai.branchId);
  } catch (err) {
    console.error("[ai] collab ingest after write failed", err);
  }
  notifyProjectAiReview(auth.projectId);
  return { ok: true, path: pathRel, writesUsed: auth.ai.writeCount };
}

async function restoreSandboxPath(auth: AiAuth, pathRel: string, before: string | null): Promise<void> {
  const root = await ensureBranchRoot(auth.projectId, auth.ai.branchId);
  if (before == null) {
    try {
      await deletePath(auth.projectId, pathRel, root);
    } catch (err) {
      const status =
        err && typeof err === "object" && "status" in err ? (err as { status: number }).status : 0;
      if (status !== 404) throw err;
    }
    notifyProjectTreeChange(auth.projectId, { op: "delete", path: pathRel }, auth.ai.branchId);
    return;
  }
  await writeFile(auth.projectId, pathRel, before, "utf8", root);
  try {
    await ingestProjectDiskPaths(auth.projectId, [pathRel], auth.ai.branchId);
  } catch (err) {
    console.error("[ai] collab ingest after rollback failed", err);
  }
}

export async function aiWriteFile(auth: AiAuth, rel: string, content: string) {
  const pathRel = await assertAiCanWrite(auth.projectId, rel);
  const before = await readSandboxText(auth, pathRel);
  return commitSandboxWrite(auth, pathRel, content, before);
}

export async function aiEdit(
  auth: AiAuth,
  input: { path: string; old: string; new: string; replace_all?: boolean },
) {
  const pathRel = await assertAiCanWrite(auth.projectId, input.path);
  if (typeof input.old !== "string" || typeof input.new !== "string") {
    throw aiError(400, "old and new must be strings");
  }
  const before = await readSandboxText(auth, pathRel);
  const beforeLf = before == null ? "" : normalizeLf(before);
  if (before == null && input.old !== "") {
    throw aiError(404, `File not found: ${pathRel}`);
  }
  let next: string;
  let replaced = 1;
  try {
    if (input.replace_all) {
      const r = replaceAllSubstrings(beforeLf, input.old, input.new);
      next = r.text;
      replaced = r.count;
    } else {
      next = replaceUnique(beforeLf, input.old, input.new);
    }
  } catch (err) {
    asAiError(err);
  }
  if (next === beforeLf) {
    return {
      ok: true as const,
      path: pathRel,
      writesUsed: auth.ai.writeCount,
      replaced: 0,
      replace_all: Boolean(input.replace_all),
      noop: true,
    };
  }
  const result = await commitSandboxWrite(auth, pathRel, next, before);
  return { ...result, replaced, replace_all: Boolean(input.replace_all) };
}

export async function aiEditRange(
  auth: AiAuth,
  input: { path: string; startLine: number; endLine: number; content: string },
) {
  const pathRel = await assertAiCanWrite(auth.projectId, input.path);
  if (typeof input.content !== "string") throw aiError(400, "content must be a string");
  const before = await readSandboxText(auth, pathRel);
  const beforeLf = before == null ? "" : normalizeLf(before);
  if (before == null && !(input.startLine === 1 && input.endLine <= 0)) {
    throw aiError(404, `File not found: ${pathRel}`);
  }
  let next: string;
  try {
    next = replaceLineRange(beforeLf, input.startLine, input.endLine, input.content);
  } catch (err) {
    asAiError(err);
  }
  const result = await commitSandboxWrite(auth, pathRel, next, before);
  return { ...result, startLine: input.startLine, endLine: input.endLine };
}

export async function aiApplyUnifiedDiff(auth: AiAuth, diff: string) {
  if (typeof diff !== "string" || !diff.trim()) throw aiError(400, "diff string required");
  if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES) {
    throw aiError(413, `Diff exceeds ${MAX_DIFF_BYTES} byte limit`);
  }
  let files;
  try {
    files = parseUnifiedDiff(diff);
  } catch (err) {
    asAiError(err);
  }
  if (files.length > MAX_PATCHES) throw aiError(400, `At most ${MAX_PATCHES} files per diff`);
  const grouped = new Map<string, typeof files>();
  for (const file of files) {
    const pathRel = await assertAiCanWrite(auth.projectId, file.path);
    const list = grouped.get(pathRel) ?? [];
    list.push(file);
    grouped.set(pathRel, list);
  }
  const planned: Array<{ path: string; before: string | null; next: string | null }> = [];
  for (const [pathRel, group] of grouped) {
    const before = await readSandboxText(auth, pathRel);
    const beforeLf = before == null ? null : normalizeLf(before);
    let next: string | null;
    try {
      next = applyFilePatches(beforeLf, group);
    } catch (err) {
      asAiError(err);
    }
    planned.push({ path: pathRel, before, next });
  }
  const mutating = planned.filter((p) => {
    const beforeLf = p.before == null ? null : normalizeLf(p.before);
    const nextLf = p.next == null ? null : normalizeLf(p.next);
    return beforeLf !== nextLf;
  });
  await assertAiSandboxWritable(auth, "written");
  if (auth.ai.writeCount + mutating.length > WRITE_QUOTA) {
    throw aiError(429, "Write quota exhausted for this AI link");
  }
  const committed: Array<{ path: string; before: string | null }> = [];
  const results = [];
  const writesBefore = auth.ai.writeCount;
  try {
    for (const p of mutating) {
      if (p.next == null) {
        snapshotBeforeWrite(auth.ai.id, p.path, p.before);
        const root = await ensureBranchRoot(auth.projectId, auth.ai.branchId);
        try {
          await deletePath(auth.projectId, p.path, root);
        } catch (err) {
          const status =
            err && typeof err === "object" && "status" in err ? (err as { status: number }).status : 0;
          if (status !== 404) throw err;
        }
        auth.ai.writeCount += 1;
        logAi(auth.ai, `deleted ${p.path}`);
        notifyProjectTreeChange(auth.projectId, { op: "delete", path: p.path }, auth.ai.branchId);
        committed.push({ path: p.path, before: p.before });
        results.push({ ok: true as const, path: p.path, deleted: true, writesUsed: auth.ai.writeCount });
      } else {
        const written = await commitSandboxWrite(auth, p.path, p.next, p.before);
        committed.push({ path: p.path, before: p.before });
        results.push(written);
      }
    }
  } catch (err) {
    for (const c of committed.reverse()) {
      try {
        await restoreSandboxPath(auth, c.path, c.before);
      } catch (restoreErr) {
        console.error("[ai] rollback after apply_diff failed", restoreErr);
      }
    }
    auth.ai.writeCount = writesBefore;
    throw err;
  }
  notifyProjectAiReview(auth.projectId);
  return { ok: true, written: results.length, results };
}

export async function aiApplyPatch(
  auth: AiAuth,
  patches: Array<{ path: string; content: string }>,
) {
  if (!Array.isArray(patches) || patches.length === 0) throw aiError(400, "patches[] required");
  if (patches.length > MAX_PATCHES) throw aiError(400, `At most ${MAX_PATCHES} patches per request`);
  const results = [];
  const committed: Array<{ path: string; before: string | null }> = [];
  const writesBefore = auth.ai.writeCount;
  try {
    for (const p of patches) {
      if (!p?.path || typeof p.content !== "string") throw aiError(400, "Each patch needs path + full content");
      const pathRel = await assertAiCanWrite(auth.projectId, p.path);
      const before = await readSandboxText(auth, pathRel);
      results.push(await aiWriteFile(auth, p.path, p.content));
      committed.push({ path: pathRel, before });
    }
  } catch (err) {
    for (const c of committed.reverse()) {
      try {
        await restoreSandboxPath(auth, c.path, c.before);
      } catch (restoreErr) {
        console.error("[ai] rollback after apply_patch failed", restoreErr);
      }
    }
    auth.ai.writeCount = writesBefore;
    throw err;
  }
  return {
    ok: true,
    written: results.length,
    results,
    note: "Each patch replaces the entire file. Prefer POST /edit or POST /apply_diff.",
  };
}

export function aiReviewCtx(auth: AiAuth): ReviewCtx {
  return reviewCtxFromAi(auth.projectId, auth.ai);
}

export function findProjectAi(projectId: string, aiId: string, _shareBranchId?: string): AiAuth {
  const ai = collaborators.get(aiId);
  if (!ai || ai.projectId !== projectId || isAiLinkDead(ai)) {
    throw aiError(404, "AI collaborator not found or inactive");
  }
  return { projectId, ai, publicUrl: publicUrlFor(projectId) };
}

export async function listProjectAiReviews(projectId: string) {
  const out = [];
  for (const ai of listLiveAi(projectId)) {
    out.push(await listAiReview(reviewCtxFromAi(projectId, ai)));
  }
  return {
    collaborators: out,
    hunkCount: out.reduce((n, c) => n + c.hunkCount, 0),
    fileCount: out.reduce((n, c) => n + c.fileCount, 0),
  };
}

export async function aiDiff(auth: AiAuth) {
  const root = await ensureBranchRoot(auth.projectId, auth.ai.branchId);
  const dirty = await isWorkingTreeDirty(auth.projectId, auth.ai.branchId);
  const timeline = await loadTimeline(auth.projectId);
  const sandbox = getBranch(timeline, auth.ai.branchId);
  const tip = sandbox.headNodeId ? timeline.nodes.find((n) => n.id === sandbox.headNodeId) : null;

  const tree = dirty
    ? await listWorkingTreeChanges(auth.projectId, auth.ai.parentTipHash, { cwd: root })
    : tip && tip.gitHash !== auth.ai.parentTipHash
      ? await listWorkingTreeChanges(auth.projectId, auth.ai.parentTipHash, {
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
  const result = await compileProject(auth.projectId, undefined, {
    branchId: auth.ai.branchId,
  });
  logAi(auth.ai, `compiled (${result.ok ? "ok" : "fail"})`);
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
  const result = await intentionalCommit(auth.projectId, {
    branchId: auth.ai.branchId,
    message: msg,
    author: { name: `AI:${auth.ai.slug}`, email: `ai-${auth.ai.id}@openleaf.local` },
  });
  logAi(auth.ai, `committed ${result.hash.slice(0, 7)} — ${msg.slice(0, 60)}`);
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
  const root = await ensureBranchRoot(auth.projectId, auth.ai.branchId);
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
  return { threads: await listComments(auth.projectId) };
}

export async function aiCreateComment(
  auth: AiAuth,
  opts: { body: string; anchor: CommentAnchor },
) {
  await assertAiSandboxWritable(auth, "commented on");
  const anchor = CommentAnchorSchema.parse(opts.anchor);
  const thread = await createComment(auth.projectId, {
    author: aiAuthor(auth.ai),
    body: opts.body,
    anchor,
  });
  notifyProjectCommentsChanged(auth.projectId);
  logAi(auth.ai, `commented on ${anchor.file}:${anchor.line}`);
  return { thread };
}

export async function aiReplyComment(auth: AiAuth, commentId: string, body: string) {
  await assertAiSandboxWritable(auth, "replied on");
  const thread = await addCommentReply(auth.projectId, commentId, {
    author: aiAuthor(auth.ai),
    body,
  });
  notifyProjectCommentsChanged(auth.projectId);
  logAi(auth.ai, `replied on ${thread.anchor.file}:${thread.anchor.line}`);
  return { thread };
}
