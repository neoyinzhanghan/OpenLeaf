/**
 * Bearer-authenticated MCP for library AI links — verify-first adds only.
 */
import { ZodError } from "zod";
import { MCP_PROTOCOL_VERSION, type McpHttpResult, type McpJsonRpcResponse } from "./aiMcp.js";
import { enrichPaper } from "./library/enrich.js";
import { lookupExternal } from "./library/import.js";
import { getPaper, searchPapers } from "./library/index.js";
import { proposeVerifiedPaper, verifyProposal, type ProposalInput } from "./library/verifyProposal.js";
import {
  assertLibraryAiAdd,
  assertLibraryAiEnrich,
  assertLibraryAiSearch,
  bumpAdd,
  bumpVerify,
  type LibraryAiAuth,
} from "./libraryAiShare.js";

type JsonRpcId = string | number | null;

function ok(id: JsonRpcId, result: unknown): McpJsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: JsonRpcId, code: number, message: string): McpJsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResult(id: JsonRpcId, payload: unknown, isError = false): McpJsonRpcResponse {
  return ok(id, {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError,
  });
}

function proposalFromArgs(args: Record<string, unknown>): ProposalInput {
  const authorsRaw = args.authors;
  let authors: ProposalInput["authors"];
  if (Array.isArray(authorsRaw)) {
    authors = authorsRaw
      .map((a) => {
        if (!a || typeof a !== "object") return null;
        const o = a as { given?: unknown; family?: unknown };
        if (typeof o.family !== "string" || !o.family.trim()) return null;
        return {
          family: o.family.trim(),
          given: typeof o.given === "string" ? o.given : "",
        };
      })
      .filter((a): a is { family: string; given: string } => Boolean(a));
  }
  return {
    doi: typeof args.doi === "string" ? args.doi : null,
    arxivId: typeof args.arxivId === "string" ? args.arxivId : null,
    url: typeof args.url === "string" ? args.url : null,
    title: typeof args.title === "string" ? args.title : null,
    authors,
    year: typeof args.year === "number" ? args.year : null,
    venue: typeof args.venue === "string" ? args.venue : null,
    abstract: typeof args.abstract === "string" ? args.abstract : null,
    tags: Array.isArray(args.tags)
      ? args.tags.filter((t): t is string => typeof t === "string")
      : null,
    notes: typeof args.notes === "string" ? args.notes : null,
    citekey: typeof args.citekey === "string" ? args.citekey : null,
  };
}

const TOOLS = [
  {
    name: "library_search",
    description: "Search the host citation library (read-only).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        tag: { type: "string" },
        collection: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "library_get",
    description: "Full library record by citekey.",
    inputSchema: {
      type: "object",
      properties: { citekey: { type: "string" } },
      required: ["citekey"],
    },
  },
  {
    name: "library_list_recent",
    description: "Recently added / updated papers in the host library.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
  },
  {
    name: "library_lookup",
    description: "Resolve external metadata (DOI / arXiv / title) WITHOUT saving.",
    inputSchema: {
      type: "object",
      properties: {
        doi: { type: "string" },
        arxivId: { type: "string" },
        title: { type: "string" },
        url: { type: "string" },
      },
    },
  },
  {
    name: "library_verify",
    description:
      "Verify a proposed citation WITHOUT saving. Returns decision=accept|reject with code/hint/expected so you can retry. Prefer DOI or arXiv. Scholar-only URLs are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        doi: { type: "string" },
        arxivId: { type: "string" },
        url: { type: "string" },
        title: { type: "string" },
        authors: {
          type: "array",
          items: {
            type: "object",
            properties: { given: { type: "string" }, family: { type: "string" } },
            required: ["family"],
          },
        },
        year: { type: "number" },
        venue: { type: "string" },
      },
    },
  },
  {
    name: "library_add",
    description:
      "Verify-first queue for host Accept/Reject. Returns decision=pending (not yet in library) or the reject payload. Never invent DOIs.",
    inputSchema: {
      type: "object",
      properties: {
        doi: { type: "string" },
        arxivId: { type: "string" },
        url: { type: "string" },
        title: { type: "string" },
        authors: {
          type: "array",
          items: {
            type: "object",
            properties: { given: { type: "string" }, family: { type: "string" } },
            required: ["family"],
          },
        },
        year: { type: "number" },
        venue: { type: "string" },
        notes: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        citekey: { type: "string" },
      },
    },
  },
  {
    name: "library_enrich",
    description: "Refresh live metadata for an existing library paper (host must enable enrich).",
    inputSchema: {
      type: "object",
      properties: { citekey: { type: "string" }, force: { type: "boolean" } },
      required: ["citekey"],
    },
  },
] as const;

async function callTool(auth: LibraryAiAuth, name: string, args: Record<string, unknown>): Promise<{
  payload: unknown;
  isError: boolean;
}> {
  const { session } = auth;
  switch (name) {
    case "library_search": {
      assertLibraryAiSearch(session);
      const query = String(args.query ?? "");
      const papers = await searchPapers({
        q: query,
        tag: typeof args.tag === "string" ? args.tag : undefined,
        collection: typeof args.collection === "string" ? args.collection : undefined,
        limit: 50,
      });
      return {
        payload: {
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
        },
        isError: false,
      };
    }
    case "library_get": {
      assertLibraryAiSearch(session);
      return { payload: await getPaper(String(args.citekey)), isError: false };
    }
    case "library_list_recent": {
      assertLibraryAiSearch(session);
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
      const papers = await searchPapers({ sort: "added", limit });
      return {
        payload: {
          papers: papers.map((p) => ({
            citekey: p.citekey,
            title: p.title,
            year: p.year,
            doi: p.doi,
            addedAt: p.addedAt,
            updatedAt: p.updatedAt,
          })),
        },
        isError: false,
      };
    }
    case "library_lookup": {
      const paper = await lookupExternal({
        doi: typeof args.doi === "string" ? args.doi : undefined,
        arxivId: typeof args.arxivId === "string" ? args.arxivId : undefined,
        title: typeof args.title === "string" ? args.title : undefined,
        url: typeof args.url === "string" ? args.url : undefined,
      });
      return { payload: { paper }, isError: false };
    }
    case "library_verify": {
      bumpVerify(session);
      const result = await verifyProposal(proposalFromArgs(args));
      return { payload: result, isError: !result.ok };
    }
    case "library_add": {
      assertLibraryAiAdd(session);
      bumpVerify(session);
      const { proposeVerifiedPaper } = await import("./library/verifyProposal.js");
      const { enqueueLibraryProposal, proposalView } = await import("./libraryAiReview.js");
      const proposed = await proposeVerifiedPaper(proposalFromArgs(args));
      if (!proposed.ok) return { payload: proposed, isError: true };
      bumpAdd(session);
      const pending = enqueueLibraryProposal(session, proposed.proposal, proposed.verify);
      return {
        payload: {
          ok: true,
          decision: "pending",
          proposalId: pending.id,
          proposal: proposalView(pending),
          hint: "Queued for host Accept/Reject. The paper is not in the library until the human accepts.",
        },
        isError: false,
      };
    }
    case "library_enrich": {
      assertLibraryAiEnrich(session);
      const result = await enrichPaper(String(args.citekey), {
        force: Boolean(args.force),
        checkIntegrity: true,
      });
      return { payload: result, isError: false };
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { status: 400 });
  }
}

function instructionsFor(auth: LibraryAiAuth): string {
  return [
    "OpenLeaf citation library AI collaborator.",
    "Verify every proposed citation before treating it as real.",
    "Prefer DOI or arXiv. On reject, read code/hint/expected and retry once — never invent identifiers.",
    `allowSearch=${auth.session.settings.allowSearch} allowAdd=${auth.session.settings.allowAdd} allowEnrich=${auth.session.settings.allowEnrich}`,
    `adds used ${auth.session.addCount}/${auth.session.settings.maxAdds}`,
  ].join(" ");
}

export async function handleLibraryAiMcpHttp(
  auth: LibraryAiAuth,
  body: unknown,
): Promise<McpHttpResult> {
  const msg = body as {
    jsonrpc?: string;
    id?: JsonRpcId;
    method?: string;
    params?: Record<string, unknown>;
  };
  const id = msg.id ?? null;

  if (msg.method === "initialize") {
    return {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      },
      body: ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "openleaf-library-ai", version: "1.0.0" },
        instructions: instructionsFor(auth),
      }),
    };
  }
  if (msg.method === "notifications/initialized" || msg.method === "notifications/cancelled") {
    return { status: 202, headers: {}, body: null };
  }
  if (msg.method === "tools/list") {
    const enabled = TOOLS.filter((t) => {
      if (t.name === "library_add") return auth.session.settings.allowAdd;
      if (t.name === "library_enrich") return auth.session.settings.allowEnrich;
      if (
        t.name === "library_search" ||
        t.name === "library_get" ||
        t.name === "library_list_recent"
      ) {
        return auth.session.settings.allowSearch;
      }
      return true;
    });
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: ok(id, { tools: enabled }),
    };
  }
  if (msg.method === "tools/call") {
    try {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
      const { payload, isError } = await callTool(auth, name, args);
      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: toolResult(id, payload, isError),
      };
    } catch (e) {
      const message =
        e instanceof ZodError ? e.message : e instanceof Error ? e.message : "Tool error";
      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: toolResult(id, { ok: false, decision: "reject", code: "INVALID_INPUT", reason: message, hint: message }, true),
      };
    }
  }
  return {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: fail(id, -32601, `Method not found: ${String(msg.method)}`),
  };
}
