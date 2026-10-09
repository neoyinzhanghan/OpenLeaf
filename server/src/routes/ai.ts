import { Router, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import {
  aiApplyPatch,
  aiApplyUnifiedDiff,
  aiCommit,
  aiCompile,
  aiCreateComment,
  aiDiff,
  aiEdit,
  aiEditRange,
  aiGetContext,
  aiListComments,
  aiListFiles,
  aiReadFile,
  aiReplyComment,
  aiReviewCtx,
  aiSearch,
  aiStatus,
  aiWriteFile,
  buildBrief,
  buildStarterPrompt,
  findProjectAi,
  guestMayRevokeAi,
  listProjectAiLinks,
  listProjectAiReviews,
  mintAiCollaborator,
  resolveAiToken,
  revokeAiCollaborator,
  aiPublicView,
} from "../services/aiShare.js";
import {
  acceptAiAll,
  acceptAiFile,
  acceptAiHunk,
  listAiReview,
  rejectAiAll,
  rejectAiFile,
  rejectAiHunk,
} from "../services/aiReview.js";
import { resolveActor } from "../services/fileAccess.js";
import { handleMcpHttp } from "../services/aiMcp.js";
import { CommentAnchorSchema } from "../services/comments.js";
import { hostOnly } from "../services/shareAuth.js";

function statusOf(err: unknown): number {
  if (err instanceof ZodError) return 400;
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return 500;
}

function bearerToken(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (typeof h === "string" && h.toLowerCase().startsWith("bearer ")) {
    const t = h.slice(7).trim();
    if (t) return t;
  }
  return undefined;
}

function requireAi(req: Request, res: Response) {
  const auth = resolveAiToken(bearerToken(req));
  if (!auth) {
    res.status(401).json({ error: "Invalid or revoked AI token", code: "AI_AUTH" });
    return null;
  }
  return auth;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Public briefing page: GET /ai/:token (no guest cookie). */
export const aiBriefRouter = Router();

aiBriefRouter.get("/:token", (req, res) => {
  const token = String(req.params.token ?? "");
  const auth = resolveAiToken(token);
  if (!auth) {
    res.status(401).type("html").send(`<!doctype html><meta charset="utf-8"><title>OpenLeaf AI</title>
<body style="font-family:system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem">
<h1>AI link inactive</h1>
<p>This token is invalid, expired, or was revoked.</p>
</body>`);
    return;
  }
  const brief = buildBrief(auth);
  const accept = req.headers.accept ?? "";
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    res.json(brief);
    return;
  }

  const { ai } = auth;
  const apiBase = `${auth.publicUrl}/api/ai/v1`;
  const prompt = buildStarterPrompt(
    `${auth.publicUrl}/ai/${ai.token}`,
    ai,
    apiBase,
  );
  const mcpUrl = `${apiBase}/mcp`;
  res.type("html").send(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenLeaf AI · ${escapeHtml(ai.branchName)}</title>
<style>
  :root { color-scheme: light dark; --ink:#1a1a1a; --muted:#666; --line:#ccc; --bg:#fafafa; --card:#fff; --accent:#0b6e4f; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#eee; --muted:#aaa; --line:#444; --bg:#121212; --card:#1c1c1c; --accent:#5dcea3; }
  }
  body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--ink); }
  main { max-width: 44rem; margin: 2.5rem auto; padding: 0 1.25rem 3rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .35rem; }
  .sub { color: var(--muted); margin: 0 0 1.5rem; font-size: .95rem; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.1rem; margin: 0 0 1rem; }
  .k { color: var(--muted); font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; }
  .v { font-family: ui-monospace, monospace; font-size: .9rem; word-break: break-all; }
  ul { margin: .4rem 0 0; padding-left: 1.2rem; }
  pre { white-space: pre-wrap; word-break: break-word; background: color-mix(in srgb, var(--accent) 8%, var(--card));
    border: 1px solid var(--line); border-radius: 8px; padding: .85rem 1rem; font-size: .85rem; }
  a { color: var(--accent); }
  .warn { font-size: .85rem; color: var(--muted); }
</style>
<main>
  <h1>OpenLeaf AI collaborator</h1>
  <p class="sub">You write only on your sandbox fork. The parent leaf stays read-only for you.</p>
  <div class="card">
    <div class="k">Parent (read-only)</div>
    <div class="v">${escapeHtml(ai.parentBranchName)} · tip ${escapeHtml(ai.parentTipHash.slice(0, 7))}</div>
  </div>
  <div class="card">
    <div class="k">Your workspace (write here)</div>
    <div class="v">${escapeHtml(ai.branchName)}</div>
  </div>
  <div class="card">
    <div class="k">API</div>
    <div class="v">${escapeHtml(String(brief.apiBase))}</div>
    <p class="warn">ChatGPT often cannot fetch this page or the tunnel URL. Prefer the host’s <strong>Copy ChatGPT prompt</strong> (self-contained API + Bearer). If you can call HTTP: use <code>Authorization: Bearer &lt;token&gt;</code>.</p>
    <p><a href="${escapeHtml(String(brief.openapi))}">OpenAPI stub</a></p>
  </div>
  <div class="card">
    <div class="k">MCP</div>
    <div class="v">${escapeHtml(mcpUrl)}</div>
    <p class="warn">Same Bearer token. Streamable HTTP JSON-RPC: <code>initialize</code>, <code>tools/list</code>, <code>tools/call</code>. Copy the MCP config from the host’s <strong>AI links</strong> drawer (Cursor / Claude Desktop).</p>
  </div>
  <div class="card">
    <div class="k">Tools</div>
    <ul>${(brief.tools as string[]).map((t) => `<li><code>${escapeHtml(t)}</code></li>`).join("")}</ul>
  </div>
  <div class="card">
    <div class="k">Self-contained prompt (paste into the model)</div>
    <pre>${escapeHtml(prompt)}</pre>
  </div>
  <p class="warn">JSON briefing: request this URL with <code>Accept: application/json</code>.</p>
</main>`);
});

/** REST tools: /api/ai/v1/* — Bearer AI token (no guest cookie). */
export const aiApiRouter = Router();

aiApiRouter.get("/openapi.json", (_req, res) => {
  res.json({
    openapi: "3.0.3",
    info: {
      title: "OpenLeaf AI collaborator",
      version: "1.0.0",
      description:
        "Sandbox-only tools for an AI fork. Parent tip is read-only. Auth: Bearer token from the /ai/<token> briefing URL. MCP Streamable HTTP lives at POST /mcp.",
    },
    servers: [{ url: "/api/ai/v1" }],
    paths: {
      "/mcp": {
        post: { summary: "MCP Streamable HTTP (JSON-RPC initialize, tools/list, tools/call)" },
        delete: { summary: "End an MCP session (Mcp-Session-Id)" },
      },
      "/context": { get: { summary: "Parent + sandbox tip hashes, dirty flag, file list" } },
      "/files": { get: { summary: "List files in the AI sandbox worktree" } },
      "/files/{path}": {
        get: { summary: "Read a text file. Query from=&to= for a 1-indexed inclusive line slice." },
        put: { summary: "Write a text file (full content — last resort)" },
      },
      "/edit": { post: { summary: "Surgical unique substring replace (preferred)" } },
      "/edit_range": { post: { summary: "Replace an inclusive 1-indexed line span" } },
      "/apply_diff": { post: { summary: "Apply a unified diff; rejected if context does not match" } },
      "/apply_patch": { post: { summary: "Write one or more files (full content each — last resort)" } },
      "/review": { get: { summary: "Pending hunks the human has not Accepted/Rejected" } },
      "/search": { get: { summary: "Search text files", parameters: [{ name: "q", in: "query", required: true }] } },
      "/diff": { get: { summary: "Diff vs parent tip (what the human reviews)" } },
      "/compile": { post: { summary: "Compile the sandbox (quota-limited)" } },
      "/commit": { post: { summary: "Intentional commit on the AI fork" } },
      "/comments": {
        get: { summary: "List shared comment threads" },
        post: { summary: "Start a comment thread (source or PDF anchor)" },
      },
      "/comments/{id}/replies": { post: { summary: "Reply in a comment thread" } },
      "/status": { get: { summary: "waiting_for_human_review + context" } },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
    security: [{ bearerAuth: [] }],
  });
});

function mcpSessionId(req: Request): string | undefined {
  const raw = req.headers["mcp-session-id"];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return undefined;
}

function sendMcp(
  res: Response,
  result: Awaited<ReturnType<typeof handleMcpHttp>>,
): void {
  for (const [key, value] of Object.entries(result.headers)) {
    res.setHeader(key, value);
  }
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, MCP-Protocol-Version");
  if (result.status === 204 || result.body == null) {
    res.status(result.status).end();
    return;
  }
  if (typeof result.body === "string") {
    res.status(result.status).send(result.body);
    return;
  }
  res.status(result.status).json(result.body);
}

aiApiRouter.options("/v1/mcp", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, MCP-Protocol-Version");
  res.status(204).end();
});

aiApiRouter.post("/v1/mcp", async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  try {
    sendMcp(
      res,
      await handleMcpHttp({
        method: "POST",
        auth,
        body: req.body,
        sessionId: mcpSessionId(req),
        origin: typeof req.headers.origin === "string" ? req.headers.origin : undefined,
        accept: typeof req.headers.accept === "string" ? req.headers.accept : undefined,
      }),
    );
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

aiApiRouter.get("/v1/mcp", async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  sendMcp(
    res,
    await handleMcpHttp({
      method: "GET",
      auth,
      body: null,
      sessionId: mcpSessionId(req),
      origin: typeof req.headers.origin === "string" ? req.headers.origin : undefined,
      accept: typeof req.headers.accept === "string" ? req.headers.accept : undefined,
    }),
  );
});

aiApiRouter.delete("/v1/mcp", async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  sendMcp(
    res,
    await handleMcpHttp({
      method: "DELETE",
      auth,
      body: null,
      sessionId: mcpSessionId(req),
      origin: typeof req.headers.origin === "string" ? req.headers.origin : undefined,
    }),
  );
});

aiApiRouter.get("/v1/context", async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  try {
    res.json(await aiGetContext(auth));
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

aiApiRouter.get("/v1/files", async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  try {
    res.json(await aiListFiles(auth));
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

const aiFilesRouter = Router({ mergeParams: true });
aiFilesRouter.get(/.*/, async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  let rel: string;
  try {
    rel = decodeURIComponent(req.path.replace(/^\//, ""));
  } catch {
    res.status(400).json({ error: "Malformed file path" });
    return;
  }
  if (!rel) {
    res.status(400).json({ error: "Missing file path" });
    return;
  }
  try {
    const fromRaw = Array.isArray(req.query.from) ? req.query.from[0] : req.query.from;
    const toRaw = Array.isArray(req.query.to) ? req.query.to[0] : req.query.to;
    const from = fromRaw != null && fromRaw !== "" ? Number(fromRaw) : undefined;
    const to = toRaw != null && toRaw !== "" ? Number(toRaw) : undefined;
    res.json(
      await aiReadFile(
        auth,
        rel,
        Number.isFinite(from) || Number.isFinite(to)
          ? { from: Number.isFinite(from) ? from : undefined, to: Number.isFinite(to) ? to : undefined }
          : undefined,
      ),
    );
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});
aiFilesRouter.put(/.*/, async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  let rel: string;
  try {
    rel = decodeURIComponent(req.path.replace(/^\//, ""));
  } catch {
    res.status(400).json({ error: "Malformed file path" });
    return;
  }
  const content = typeof req.body?.content === "string" ? req.body.content : null;
  if (!rel || content == null) {
    res.status(400).json({ error: "path + body.content (string) required" });
    return;
  }
  try {
    res.json(await aiWriteFile(auth, rel, content));
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});
aiApiRouter.use("/v1/files", aiFilesRouter);

aiApiRouter.post("/v1/edit", async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  const schema = z
    .object({
      path: z.string().min(1),
      old: z.string().optional(),
      new: z.string().optional(),
      old_string: z.string().optional(),
      new_string: z.string().optional(),
      replace_all: z.boolean().optional(),
      replaceAll: z.boolean().optional(),
    })
    .transform((v, ctx) => {
      const old = v.old ?? v.old_string;
      const neu = v.new ?? v.new_string;
      if (old === undefined || neu === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "old/new (or old_string/new_string) required" });
        return z.NEVER;
      }
      return {
        path: v.path,
        old,
        new: neu,
        replace_all: v.replace_all ?? v.replaceAll,
      };
    });
  try {
    const body = schema.parse(req.body ?? {});
    res.json(await aiEdit(auth, body));
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

aiApiRouter.post("/v1/edit_range", async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  const intLine = z.union([z.number(), z.string()]).transform((v, ctx) => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isInteger(n)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "line numbers must be integers" });
      return z.NEVER;
    }
    return n;
  });
  const schema = z.object({
    path: z.string().min(1),
    startLine: intLine,
    endLine: intLine,
    content: z.string(),
  });
  try {
    const body = schema.parse(req.body ?? {});
    res.json(await aiEditRange(auth, body));
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

aiApiRouter.post("/v1/apply_diff", async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  try {
    const diff =
      typeof req.body?.diff === "string"
        ? req.body.diff
        : typeof req.body?.patch === "string"
          ? req.body.patch
          : "";
    if (!diff && Array.isArray(req.body?.patches)) {
      res.status(400).json({
        error: "POST /apply_diff needs a unified diff string in { diff }. For full-file rewrites use POST /apply_patch.",
      });
      return;
    }
    res.json(await aiApplyUnifiedDiff(auth, diff));
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

aiApiRouter.post("/v1/apply_patch", async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  try {
    const patches = Array.isArray(req.body?.patches) ? req.body.patches : [];
    res.json(await aiApplyPatch(auth, patches));
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

aiApiRouter.get("/v1/review", async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  try {
    res.json(await listAiReview(aiReviewCtx(auth)));
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

aiApiRouter.get("/v1/search", async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  try {
    res.json(await aiSearch(auth, String(req.query.q ?? "")));
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

aiApiRouter.get("/v1/diff", async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  try {
    res.json(await aiDiff(auth));
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

aiApiRouter.post("/v1/compile", async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  try {
    res.json(await aiCompile(auth));
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

aiApiRouter.post("/v1/commit", async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  try {
    res.json(await aiCommit(auth, String(req.body?.message ?? "")));
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

aiApiRouter.get("/v1/comments", async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  try {
    res.json(await aiListComments(auth));
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

aiApiRouter.post("/v1/comments", async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  const schema = z.object({
    body: z.string().min(1).max(8000),
    anchor: CommentAnchorSchema,
  });
  try {
    const body = schema.parse(req.body ?? {});
    const out = await aiCreateComment(auth, body);
    res.status(201).json(out);
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

aiApiRouter.post("/v1/comments/:commentId/replies", async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  const schema = z.object({ body: z.string().min(1).max(8000) });
  try {
    const body = schema.parse(req.body ?? {});
    const out = await aiReplyComment(auth, String(req.params.commentId), body.body);
    res.status(201).json(out);
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

aiApiRouter.get("/v1/status", async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  try {
    res.json(await aiStatus(auth));
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

const MintSchema = z
  .object({
    branchId: z.string().min(1),
    slug: z.string().min(1).max(40),
    ttlMinutes: z.number().int().positive().nullable().optional(),
    fromNodeId: z.string().min(1).nullable().optional(),
  })
  .strict();

function pid(req: { params: unknown }): string {
  return String((req.params as { id?: string }).id ?? "");
}

function assertCanMintFrom(req: Request, parentBranchId: string): void {
  const access = req.access;
  if (!access || access.mode === "host") return;
  if (access.mode === "guest") {
    if (access.session.settings.readOnly) {
      throw Object.assign(new Error("This share link is read-only — you cannot mint AI links"), { status: 403 });
    }
    if (parentBranchId !== access.session.branchId) {
      throw Object.assign(
        new Error("You can only mint an AI link from the leaf this share grants you"),
        { status: 403 },
      );
    }
    return;
  }
  throw Object.assign(new Error("Not allowed"), { status: 403 });
}

function mintedByFrom(req: Request): { kind: "host" } | { kind: "guest"; guestId: string; guestName: string } {
  if (req.access?.mode === "guest") {
    return { kind: "guest", guestId: req.access.guest.id, guestName: req.access.guest.name };
  }
  return { kind: "host" };
}

function assertCanRevoke(req: Request, ai: { parentBranchId: string; mintedBy: import("../services/aiShare.js").AiMintedBy }): void {
  const access = req.access;
  if (!access || access.mode === "host") return;
  if (access.mode === "guest") {
    const allowed = guestMayRevokeAi(access.guest.id, access.session.branchId, ai);
    if (!allowed.ok) throw Object.assign(new Error(allowed.error), { status: 403 });
    return;
  }
  throw Object.assign(new Error("Not allowed"), { status: 403 });
}

/**
 * Independent AI links — mounted at /api/projects/:id/ai and aliased at /share/ai.
 * Mint/list/revoke: host, or a write-capable guest on their bound leaf.
 * Review accept/reject: host only.
 */
export const projectAiRouter = Router({ mergeParams: true });

projectAiRouter.get("/", (req, res) => {
  const projectId = pid(req);
  const parentRaw = req.query.parentBranchId;
  const parentBranchId = typeof parentRaw === "string" && parentRaw ? parentRaw : undefined;
  const list = listProjectAiLinks(projectId, parentBranchId);
  if (req.access?.mode === "guest") {
    const bound = req.access.session.branchId;
    list.collaborators = list.collaborators.filter((c) => c.parentBranchId === bound);
  }
  res.json(list);
});

projectAiRouter.post("/", async (req, res) => {
  try {
    const body = MintSchema.parse(req.body ?? {});
    assertCanMintFrom(req, body.branchId);
    const result = await mintAiCollaborator(pid(req), body.branchId, {
      slug: body.slug,
      ttlMinutes: body.ttlMinutes,
      fromNodeId: req.access?.mode === "guest" ? null : body.fromNodeId,
      mintedBy: mintedByFrom(req),
    });
    const list = listProjectAiLinks(pid(req));
    if (req.access?.mode === "guest") {
      const bound = req.access.session.branchId;
      list.collaborators = list.collaborators.filter((c) => c.parentBranchId === bound);
    }
    res.status(201).json({
      ok: true,
      ai: { ...aiPublicView(result.ai), token: result.ai.token, mintedBy: result.ai.mintedBy },
      aiUrl: result.aiUrl,
      starterPrompt: result.starterPrompt,
      mcpUrl: result.mcpUrl,
      mcpConfig: result.mcpConfig,
      gateway: result.gateway,
      collaborators: list.collaborators,
    });
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed to mint AI link" });
  }
});

projectAiRouter.get("/review", hostOnly, async (req, res) => {
  try {
    res.json(await listProjectAiReviews(pid(req)));
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

const ReviewActionSchema = z
  .object({
    hunkId: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    all: z.boolean().optional(),
  })
  .strict();

projectAiRouter.get("/:aiId/review", hostOnly, async (req, res) => {
  try {
    const auth = findProjectAi(pid(req), String(req.params.aiId));
    res.json(await listAiReview(aiReviewCtx(auth)));
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

projectAiRouter.post("/:aiId/review/accept", hostOnly, async (req, res) => {
  try {
    const body = ReviewActionSchema.parse(req.body ?? {});
    const auth = findProjectAi(pid(req), String(req.params.aiId));
    const ctx = { ...aiReviewCtx(auth), actor: resolveActor(req) };
    let review;
    if (body.all) review = await acceptAiAll(ctx);
    else if (body.path) review = await acceptAiFile(ctx, body.path);
    else if (body.hunkId) review = await acceptAiHunk(ctx, body.hunkId);
    else {
      res.status(400).json({ error: "Provide hunkId, path, or all: true" });
      return;
    }
    res.json(review);
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

projectAiRouter.post("/:aiId/review/reject", hostOnly, async (req, res) => {
  try {
    const body = ReviewActionSchema.parse(req.body ?? {});
    const auth = findProjectAi(pid(req), String(req.params.aiId));
    const ctx = { ...aiReviewCtx(auth), actor: resolveActor(req) };
    let review;
    if (body.all) review = await rejectAiAll(ctx);
    else if (body.path) review = await rejectAiFile(ctx, body.path);
    else if (body.hunkId) review = await rejectAiHunk(ctx, body.hunkId);
    else {
      res.status(400).json({ error: "Provide hunkId, path, or all: true" });
      return;
    }
    res.json(review);
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

projectAiRouter.delete("/:aiId", (req, res) => {
  try {
    const projectId = pid(req);
    const auth = findProjectAi(projectId, String(req.params.aiId));
    assertCanRevoke(req, auth.ai);
    const ok = revokeAiCollaborator(projectId, String(req.params.aiId));
    if (!ok) {
      res.status(404).json({ error: "AI collaborator not found" });
      return;
    }
    res.json({ ok: true, ...listProjectAiLinks(projectId) });
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

/** @deprecated alias — same router as /api/projects/:id/ai */
export const projectAiShareRouter = projectAiRouter;
