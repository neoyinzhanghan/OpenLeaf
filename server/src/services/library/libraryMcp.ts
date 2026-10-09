/**
 * Host-local MCP surface for the citation library.
 *
 * NOTE: This MCP surface inherits OpenLeaf's local-trust-no-auth model but can
 * trigger outbound network fetches and file writes. If it is ever exposed over
 * a Share session, it needs the same risk-acknowledgment gate Share already
 * requires — do NOT wire it into Share in this feature; leave this note.
 *
 * Thin wrapper over server/services/library — same service layer as REST.
 */
import { ZodError } from "zod";
import { searchPapers, getPaper, listAllRecords } from "./index.js";
import { lookupExternal, importFromLink, importBibtex } from "./import.js";
import { citeIntoProject } from "./cite.js";
import {
  checkProjectCitationIntegrity,
  verifyClaimInstance,
  scanProjectCitations,
} from "./citations.js";
import { getTree } from "../projectFs.js";
import { getSourceClients } from "./sources/index.js";
import { MCP_PROTOCOL_VERSION, type McpHttpResult, type McpJsonRpcResponse } from "../aiMcp.js";

type JsonRpcId = string | number | null;

function ok(id: JsonRpcId, result: unknown): McpJsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: JsonRpcId, code: number, message: string): McpJsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const TOOLS = [
  {
    name: "library_search",
    description: "Search the local citation library.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, tag: { type: "string" }, collection: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "library_lookup",
    description: "Resolve external metadata (DOI / arXiv / title) without saving — preview before import.",
    inputSchema: {
      type: "object",
      properties: { doi: { type: "string" }, arxivId: { type: "string" }, title: { type: "string" } },
    },
  },
  {
    name: "library_add",
    description: "Import into the library (DOI / arXiv / URL / BibTeX). Dedupes by DOI.",
    inputSchema: {
      type: "object",
      properties: {
        doi: { type: "string" },
        arxivId: { type: "string" },
        url: { type: "string" },
        bibtex: { type: "string" },
      },
    },
  },
  {
    name: "library_get",
    description: "Full library record including notes and attachment path.",
    inputSchema: {
      type: "object",
      properties: { citekey: { type: "string" } },
      required: ["citekey"],
    },
  },
  {
    name: "library_find_related",
    description: "Candidate related papers via OpenAlex title search (literature-review aid).",
    inputSchema: {
      type: "object",
      properties: { citekey: { type: "string" }, topic: { type: "string" } },
    },
  },
  {
    name: "project_cite",
    description: "Insert \\cite{citekey} at file:line and sync the citekey into the project .bib.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        citekey: { type: "string" },
        file: { type: "string" },
        line: { type: "number" },
      },
      required: ["projectId", "citekey"],
    },
  },
  {
    name: "citations_check_integrity",
    description: "Existence / retraction / claim-support checks for every citation in a project.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" }, force: { type: "boolean" } },
      required: ["projectId"],
    },
  },
  {
    name: "citations_verify_claim",
    description: "On-demand claim-support check for one citation instance.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        file: { type: "string" },
        line: { type: "number" },
        citekey: { type: "string" },
      },
      required: ["projectId", "file", "line"],
    },
  },
] as const;

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "library_search": {
      const query = String(args.query ?? "");
      return { papers: await searchPapers({ q: query, tag: args.tag as string | undefined, collection: args.collection as string | undefined }) };
    }
    case "library_lookup": {
      const paper = await lookupExternal({
        doi: args.doi as string | undefined,
        arxivId: args.arxivId as string | undefined,
        title: args.title as string | undefined,
      });
      return { paper };
    }
    case "library_add": {
      if (typeof args.bibtex === "string" && args.bibtex.trim()) {
        return importBibtex(args.bibtex);
      }
      const link =
        (typeof args.url === "string" && args.url) ||
        (typeof args.doi === "string" && args.doi) ||
        (typeof args.arxivId === "string" && `arxiv:${args.arxivId}`) ||
        "";
      if (!link) throw Object.assign(new Error("Provide doi, arxivId, url, or bibtex"), { status: 400 });
      return importFromLink(link);
    }
    case "library_get":
      return getPaper(String(args.citekey));
    case "library_find_related": {
      let topic = typeof args.topic === "string" ? args.topic : "";
      if (!topic && typeof args.citekey === "string") {
        const paper = await getPaper(args.citekey);
        topic = paper.title;
      }
      if (!topic) return { candidates: [] };
      const clients = getSourceClients();
      const hit = await clients.openalex.searchByTitle(topic);
      // OpenAlex search returns one best hit; list local library as additional context.
      const local = await listAllRecords();
      return {
        candidates: [
          ...(hit ? [{ ...hit, source: "openalex" }] : []),
          ...local
            .filter((p) => p.title.toLowerCase().includes(topic.toLowerCase().slice(0, 20)))
            .slice(0, 10)
            .map((p) => ({ ...p, source: "library" })),
        ],
      };
    }
    case "project_cite": {
      const projectId = String(args.projectId);
      const citekey = String(args.citekey);
      return citeIntoProject(projectId, {
        citekey,
        file: args.file as string | undefined,
        line: typeof args.line === "number" ? args.line : undefined,
      });
    }
    case "citations_check_integrity": {
      const projectId = String(args.projectId);
      const tree = await getTree(projectId);
      const files: string[] = [];
      const walk = (nodes: typeof tree) => {
        for (const n of nodes) {
          if (n.type === "file" && n.path.endsWith(".tex")) files.push(n.path);
          if (n.children) walk(n.children);
        }
      };
      walk(tree);
      await scanProjectCitations(projectId, files);
      return checkProjectCitationIntegrity(projectId, {
        texFiles: files,
        force: Boolean(args.force),
      });
    }
    case "citations_verify_claim": {
      return verifyClaimInstance(String(args.projectId), String(args.file), Number(args.line), {
        citekey: args.citekey as string | undefined,
        force: true,
      });
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { status: 400 });
  }
}

export async function handleLibraryMcpHttp(body: unknown): Promise<McpHttpResult> {
  const msg = body as { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: Record<string, unknown> };
  const id = msg.id ?? null;

  if (msg.method === "initialize") {
    return {
      status: 200,
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": MCP_PROTOCOL_VERSION },
      body: ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "openleaf-library", version: "1.0.0" },
      }),
    };
  }
  if (msg.method === "notifications/initialized" || msg.method === "notifications/cancelled") {
    return { status: 202, headers: {}, body: null };
  }
  if (msg.method === "tools/list") {
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: ok(id, { tools: TOOLS }),
    };
  }
  if (msg.method === "tools/call") {
    try {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
      const result = await callTool(name, args);
      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: ok(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        }),
      };
    } catch (err) {
      const message = err instanceof ZodError ? err.message : err instanceof Error ? err.message : "Tool error";
      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: fail(id, -32000, message),
      };
    }
  }
  return {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: fail(id, -32601, `Method not found: ${String(msg.method)}`),
  };
}
