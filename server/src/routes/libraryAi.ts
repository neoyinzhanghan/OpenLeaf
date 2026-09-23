/**
 * Library AI collaborator HTTP surface.
 * Host mint: /api/library-ai  (hostOnly)
 * Public AI: /api/library-ai/v1/* + /library-ai/:token briefing
 */
import { Router, type Request, type Response } from "express";
import { ZodError, z } from "zod";
import { loadConfig } from "../config.js";
import { handleLibraryAiMcpHttp } from "../services/libraryAiMcp.js";
import { enrichPaper } from "../services/library/enrich.js";
import { lookupExternal } from "../services/library/import.js";
import { getPaper, searchPapers } from "../services/library/index.js";
import { proposeVerifiedPaper, verifyProposal } from "../services/library/verifyProposal.js";
import {
  assertLibraryAiAdd,
  assertLibraryAiEnrich,
  assertLibraryAiSearch,
  bumpAdd,
  bumpVerify,
  getLibraryAiById,
  libraryAiBrief,
  libraryAiHostView,
  listLibraryAiSessions,
  mintLibraryAi,
  resolveLibraryAiToken,
  revokeLibraryAi,
} from "../services/libraryAiShare.js";
import {
  acceptAllLibraryProposals,
  acceptLibraryProposal,
  enqueueLibraryProposal,
  listPendingLibraryProposals,
  pendingLibraryProposalCount,
  proposalView,
  rejectAllLibraryProposals,
  rejectLibraryProposal,
} from "../services/libraryAiReview.js";
import { hostOnly } from "../services/shareAuth.js";

function statusOf(err: unknown): number {
  if (err instanceof ZodError) return 400;
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return 500;
}

function sendError(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : "Library AI error";
  res.status(statusOf(err)).json({ error: message });
}

function bearerToken(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (typeof h === "string" && h.toLowerCase().startsWith("bearer ")) {
    const t = h.slice(7).trim();
    if (t) return t;
  }
  return undefined;
}

function requireLibraryAi(req: Request, res: Response) {
  const auth = resolveLibraryAiToken(bearerToken(req));
  if (!auth) {
    res.status(401).json({ error: "Invalid or revoked library AI token", code: "LIBRARY_AI_AUTH" });
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

const ProposalSchema = z.object({
  doi: z.string().nullable().optional(),
  arxivId: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  authors: z
    .array(z.object({ given: z.string().default(""), family: z.string().min(1) }))
    .optional(),
  year: z.number().int().nullable().optional(),
  venue: z.string().nullable().optional(),
  abstract: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().nullable().optional(),
  citekey: z.string().nullable().optional(),
});

const MintSchema = z.object({
  riskAck: z.literal(true),
  ttlMinutes: z.number().int().positive().nullable().optional(),
  settings: z
    .object({
      allowSearch: z.boolean().optional(),
      allowAdd: z.boolean().optional(),
      allowEnrich: z.boolean().optional(),
      maxAdds: z.number().int().positive().optional(),
      title: z.string().optional(),
    })
    .optional(),
});

/** Host-only mint / list / revoke. */
export const libraryAiHostRouter = Router();
libraryAiHostRouter.use(hostOnly);

libraryAiHostRouter.get("/", (_req, res) => {
  try {
    const port = loadConfig().port;
    res.json({
      sessions: listLibraryAiSessions().map((s) => libraryAiHostView(s, port)),
      pendingCount: pendingLibraryProposalCount(),
    });
  } catch (err) {
    sendError(res, err);
  }
});

libraryAiHostRouter.get("/review", (_req, res) => {
  try {
    const proposals = listPendingLibraryProposals().map(proposalView);
    res.json({ proposals, count: proposals.length });
  } catch (err) {
    sendError(res, err);
  }
});

libraryAiHostRouter.post("/review/accept", async (req, res) => {
  try {
    if (req.body?.all === true) {
      const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : undefined;
      const result = await acceptAllLibraryProposals(sessionId);
      res.json(result);
      return;
    }
    const proposalId = typeof req.body?.proposalId === "string" ? req.body.proposalId : "";
    if (!proposalId) {
      res.status(400).json({ error: "proposalId or all=true required" });
      return;
    }
    const result = await acceptLibraryProposal(proposalId);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

libraryAiHostRouter.post("/review/reject", (req, res) => {
  try {
    if (req.body?.all === true) {
      const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : undefined;
      const count = rejectAllLibraryProposals(sessionId);
      res.json({ rejected: count });
      return;
    }
    const proposalId = typeof req.body?.proposalId === "string" ? req.body.proposalId : "";
    if (!proposalId) {
      res.status(400).json({ error: "proposalId or all=true required" });
      return;
    }
    if (!rejectLibraryProposal(proposalId)) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }
    res.json({ rejected: 1 });
  } catch (err) {
    sendError(res, err);
  }
});

libraryAiHostRouter.post("/", (req, res) => {
  try {
    const body = MintSchema.parse(req.body ?? {});
    const minted = mintLibraryAi({
      riskAck: body.riskAck,
      ttlMinutes: body.ttlMinutes,
      settings: body.settings,
      port: loadConfig().port,
    });
    res.status(201).json({
      session: libraryAiHostView(minted.session, loadConfig().port),
      libraryAiUrl: minted.libraryAiUrl,
      starterPrompt: minted.starterPrompt,
      mcpUrl: minted.mcpUrl,
      mcpConfig: minted.mcpConfig,
    });
  } catch (err) {
    sendError(res, err);
  }
});

libraryAiHostRouter.delete("/:id", (req, res) => {
  try {
    const ok = revokeLibraryAi(req.params.id);
    if (!ok) {
      const existing = getLibraryAiById(req.params.id);
      if (!existing) {
        res.status(404).json({ error: "Library AI link not found" });
        return;
      }
    }
    res.status(204).end();
  } catch (err) {
    sendError(res, err);
  }
});

/** Public briefing HTML/JSON: GET /library-ai/:token */
export const libraryAiBriefRouter = Router();

libraryAiBriefRouter.get("/:token", (req, res) => {
  const auth = resolveLibraryAiToken(req.params.token);
  if (!auth) {
    res.status(404).type("html").send("<!doctype html><p>Library AI link not found or expired.</p>");
    return;
  }
  const brief = libraryAiBrief(auth);
  const accept = req.headers.accept ?? "";
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    res.json(brief);
    return;
  }
  const prompt = String(brief.starterPrompt ?? "");
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"/><title>OpenLeaf Library AI</title>
<style>
body{font-family:system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;line-height:1.45}
code,pre{font-family:ui-monospace,monospace;font-size:0.85rem}
pre{background:#111;color:#eee;padding:1rem;border-radius:8px;overflow:auto;white-space:pre-wrap}
.muted{color:#666}
</style></head><body>
<h1>${escapeHtml(auth.session.settings.title)}</h1>
<p class="muted">Paste the starter prompt into ChatGPT (preferred). Many clients block fetching this page.</p>
<pre id="prompt">${escapeHtml(prompt)}</pre>
<p><button type="button" onclick="navigator.clipboard.writeText(document.getElementById('prompt').innerText)">Copy prompt</button></p>
<p class="muted">API base: <code>${escapeHtml(auth.apiBase)}</code></p>
</body></html>`);
});

/** Bearer-authenticated AI tools. */
export const libraryAiApiRouter = Router();

libraryAiApiRouter.get("/context", (req, res) => {
  const auth = requireLibraryAi(req, res);
  if (!auth) return;
  res.json({
    kind: "openleaf-library-ai",
    settings: auth.session.settings,
    usage: { addCount: auth.session.addCount, verifyCount: auth.session.verifyCount },
    apiBase: auth.apiBase,
  });
});

libraryAiApiRouter.get("/search", async (req, res) => {
  const auth = requireLibraryAi(req, res);
  if (!auth) return;
  try {
    assertLibraryAiSearch(auth.session);
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const papers = await searchPapers({
      q: q || undefined,
      tag: typeof req.query.tag === "string" ? req.query.tag : undefined,
      collection: typeof req.query.collection === "string" ? req.query.collection : undefined,
      limit: 50,
    });
    res.json({
      papers: papers.map((p) => ({
        citekey: p.citekey,
        title: p.title,
        year: p.year,
        doi: p.doi,
        arxivId: p.arxivId,
        authors: p.authors,
        venue: p.venue,
        integrity: p.integrity,
      })),
    });
  } catch (err) {
    sendError(res, err);
  }
});

libraryAiApiRouter.get("/recent", async (req, res) => {
  const auth = requireLibraryAi(req, res);
  if (!auth) return;
  try {
    assertLibraryAiSearch(auth.session);
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 20;
    const papers = await searchPapers({
      sort: "added",
      limit: Math.min(100, Math.max(1, Number.isFinite(limit) ? limit : 20)),
    });
    res.json({
      papers: papers.map((p) => ({
        citekey: p.citekey,
        title: p.title,
        year: p.year,
        doi: p.doi,
        addedAt: p.addedAt,
        updatedAt: p.updatedAt,
      })),
    });
  } catch (err) {
    sendError(res, err);
  }
});

libraryAiApiRouter.get("/papers/:citekey", async (req, res) => {
  const auth = requireLibraryAi(req, res);
  if (!auth) return;
  try {
    assertLibraryAiSearch(auth.session);
    res.json(await getPaper(req.params.citekey));
  } catch (err) {
    sendError(res, err);
  }
});

libraryAiApiRouter.post("/lookup", async (req, res) => {
  const auth = requireLibraryAi(req, res);
  if (!auth) return;
  try {
    const body = ProposalSchema.parse(req.body ?? {});
    const paper = await lookupExternal({
      doi: body.doi ?? undefined,
      arxivId: body.arxivId ?? undefined,
      title: body.title ?? undefined,
      url: body.url ?? undefined,
    });
    res.json({ paper });
  } catch (err) {
    sendError(res, err);
  }
});

libraryAiApiRouter.post("/verify", async (req, res) => {
  const auth = requireLibraryAi(req, res);
  if (!auth) return;
  try {
    const body = ProposalSchema.parse(req.body ?? {});
    bumpVerify(auth.session);
    const result = await verifyProposal(body);
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    sendError(res, err);
  }
});

libraryAiApiRouter.post("/add", async (req, res) => {
  const auth = requireLibraryAi(req, res);
  if (!auth) return;
  try {
    assertLibraryAiAdd(auth.session);
    const body = ProposalSchema.parse(req.body ?? {});
    bumpVerify(auth.session);
    const proposed = await proposeVerifiedPaper(body);
    if (!proposed.ok) {
      res.status(422).json(proposed);
      return;
    }
    bumpAdd(auth.session);
    const pending = enqueueLibraryProposal(auth.session, proposed.proposal, proposed.verify);
    res.status(202).json({
      ok: true,
      decision: "pending",
      proposalId: pending.id,
      proposal: proposalView(pending),
      hint: "Queued for host Accept/Reject. The paper is not in the library until the human accepts.",
    });
  } catch (err) {
    sendError(res, err);
  }
});

libraryAiApiRouter.post("/enrich/:citekey", async (req, res) => {
  const auth = requireLibraryAi(req, res);
  if (!auth) return;
  try {
    assertLibraryAiEnrich(auth.session);
    const result = await enrichPaper(req.params.citekey, {
      force: Boolean(req.body?.force),
      checkIntegrity: true,
    });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

libraryAiApiRouter.post("/mcp", async (req, res) => {
  const auth = requireLibraryAi(req, res);
  if (!auth) return;
  try {
    const result = await handleLibraryAiMcpHttp(auth, req.body);
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
    if (result.status === 202) {
      res.status(202).end();
      return;
    }
    res.status(result.status).json(result.body);
  } catch (err) {
    sendError(res, err);
  }
});
