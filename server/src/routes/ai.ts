import { Router, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import {
  aiApplyPatch,
  aiCommit,
  aiCompile,
  aiCreateComment,
  aiDiff,
  aiGetContext,
  aiListComments,
  aiListFiles,
  aiReadFile,
  aiReplyComment,
  aiSearch,
  aiStatus,
  aiWriteFile,
  buildBrief,
  buildStarterPrompt,
  mintAiCollaborator,
  resolveAiToken,
  revokeAiCollaborator,
  aiPublicView,
} from "../services/aiShare.js";
import { CommentAnchorSchema } from "../services/comments.js";
import { getShare, hostView, listSharesForProject } from "../services/share.js";
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
<p>This token is invalid, expired, or the share session ended.</p>
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
  const prompt = buildStarterPrompt(
    `${auth.session.url}/ai/${ai.token}`,
    ai,
    `${auth.session.url}/api/ai/v1`,
  );
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
  <p class="sub">You write only on your sandbox fork. The human share tip stays read-only for you.</p>
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
        "Sandbox-only tools for an AI fork. Parent tip is read-only. Auth: Bearer token from the /ai/<token> briefing URL.",
    },
    servers: [{ url: "/api/ai/v1" }],
    paths: {
      "/context": { get: { summary: "Parent + sandbox tip hashes, dirty flag, file list" } },
      "/files": { get: { summary: "List files in the AI sandbox worktree" } },
      "/files/{path}": {
        get: { summary: "Read a text file" },
        put: { summary: "Write a text file (full content)" },
      },
      "/apply_patch": { post: { summary: "Write one or more files (full content each)" } },
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
  const rel = decodeURIComponent(req.path.replace(/^\//, ""));
  if (!rel) {
    res.status(400).json({ error: "Missing file path" });
    return;
  }
  try {
    res.json(await aiReadFile(auth, rel));
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});
aiFilesRouter.put(/.*/, async (req, res) => {
  const auth = requireAi(req, res);
  if (!auth) return;
  const rel = decodeURIComponent(req.path.replace(/^\//, ""));
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
  })
  .strict();

/**
 * Host mint / revoke — mounted under /api/projects/:id/share/ai
 */
export const projectAiShareRouter = Router({ mergeParams: true });
projectAiShareRouter.use(hostOnly);

function pid(req: { params: unknown }): string {
  return String((req.params as { id?: string }).id ?? "");
}

projectAiShareRouter.post("/", async (req, res) => {
  try {
    const body = MintSchema.parse(req.body ?? {});
    const result = await mintAiCollaborator(pid(req), body.branchId, {
      slug: body.slug,
      ttlMinutes: body.ttlMinutes,
    });
    res.status(201).json({
      ok: true,
      ai: { ...aiPublicView(result.ai), token: result.ai.token },
      aiUrl: result.aiUrl,
      starterPrompt: result.starterPrompt,
      session: result.session,
      sessions: listSharesForProject(pid(req)).map(hostView),
    });
  } catch (err) {
    res.status(statusOf(err)).json({ error: err instanceof Error ? err.message : "Failed to mint AI link" });
  }
});

projectAiShareRouter.delete("/:aiId", (req, res) => {
  const branchId = typeof req.query.branchId === "string" ? req.query.branchId : undefined;
  if (!branchId) {
    res.status(400).json({ error: "branchId query required" });
    return;
  }
  const ok = revokeAiCollaborator(pid(req), branchId, String(req.params.aiId));
  if (!ok) {
    res.status(404).json({ error: "AI collaborator not found" });
    return;
  }
  const s = getShare(pid(req), branchId);
  res.json({
    ok: true,
    session: s ? hostView(s) : undefined,
    sessions: listSharesForProject(pid(req)).map(hostView),
  });
});
