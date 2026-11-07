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
  {
    name: "source_add_web",
    description: "Save a web page as a library source (text snapshot). Returns citekey.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        title: { type: "string" },
        collection: { type: "string" },
      },
      required: ["url"],
    },
  },
  {
    name: "facts_search",
    description: "Search library facts by text/key/source/status.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        citekey: { type: "string" },
        status: { type: "string" },
        type: { type: "string" },
      },
    },
  },
  {
    name: "fact_get",
    description: "One fact with passages and status.",
    inputSchema: {
      type: "object",
      properties: { citekey: { type: "string" }, id: { type: "string" }, key: { type: "string" } },
    },
  },
  {
    name: "fact_propose",
    description:
      "Create an unreviewed fact on a source. Every quote must appear verbatim in the source text. Never confirms.",
    inputSchema: {
      type: "object",
      properties: {
        citekey: { type: "string" },
        type: { type: "string" },
        input: { type: "string" },
        answer: { type: "string" },
        quotes: { type: "array", items: { type: "string" } },
        key: { type: "string" },
        value: { type: "number" },
        unit: { type: "string" },
        agentName: { type: "string" },
      },
      required: ["citekey", "type", "input", "quotes"],
    },
  },
  {
    name: "knowledge_list",
    description: "List knowledge items with ids, titles, collections.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "knowledge_get",
    description: "One knowledge item with tex, steps, values.",
    inputSchema: {
      type: "object",
      properties: { knowledgeId: { type: "string" }, projectId: { type: "string" } },
    },
  },
  {
    name: "knowledge_create",
    description: "Create a knowledge item project from the template.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, collection: { type: "string" } },
      required: ["title"],
    },
  },
  {
    name: "knowledge_check",
    description: "Parse/evaluate a knowledge item; return errors, values, statuses.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
    },
  },
  {
    name: "graph_neighborhood",
    description: "Nodes and edges around a graph node up to depth N.",
    inputSchema: {
      type: "object",
      properties: { node: { type: "string" }, depth: { type: "number" } },
      required: ["node"],
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
    case "source_add_web": {
      const { addWebSource } = await import("./webSource.js");
      const result = await addWebSource({
        url: String(args.url),
        title: typeof args.title === "string" ? args.title : undefined,
        collections: typeof args.collection === "string" ? [args.collection] : undefined,
      });
      return { citekey: result.paper.citekey, paper: result.paper, snapshot: result.snapshot };
    }
    case "facts_search": {
      const { listAllFacts, FactStatusSchema, FactTypeSchema } = await import("./facts.js");
      const status =
        typeof args.status === "string" ? FactStatusSchema.parse(args.status) : undefined;
      const type = typeof args.type === "string" ? FactTypeSchema.parse(args.type) : undefined;
      return {
        facts: await listAllFacts({
          q: typeof args.q === "string" ? args.q : undefined,
          citekey: typeof args.citekey === "string" ? args.citekey : undefined,
          status,
          type,
        }),
      };
    }
    case "fact_get": {
      const { listFacts, listAllFacts } = await import("./facts.js");
      if (typeof args.citekey === "string" && typeof args.id === "string") {
        const facts = await listFacts(args.citekey);
        const fact = facts.find((f) => f.id === args.id);
        if (!fact) throw Object.assign(new Error("Fact not found"), { status: 404 });
        return { fact };
      }
      if (typeof args.key === "string") {
        const all = await listAllFacts({ q: args.key });
        const fact = all.find((f) => f.key === args.key);
        if (!fact) throw Object.assign(new Error("Fact not found"), { status: 404 });
        return { fact };
      }
      throw Object.assign(new Error("Provide citekey+id or key"), { status: 400 });
    }
    case "fact_propose": {
      const { createFact } = await import("./facts.js");
      const { getSourceText } = await import("./sourceText.js");
      const { locateQuoteInPages } = await import("./pdfText.js");
      const citekey = String(args.citekey);
      const quotes = Array.isArray(args.quotes) ? args.quotes.map(String) : [];
      if (!quotes.length) throw Object.assign(new Error("quotes[] required"), { status: 400 });
      const { pages } = await getSourceText(citekey);
      const highlights = [];
      for (const q of quotes) {
        const hits = locateQuoteInPages(pages, q);
        if (!hits.length) {
          throw Object.assign(new Error(`Quote not found in source: “${q.slice(0, 80)}”`), {
            status: 400,
          });
        }
        highlights.push(hits[0]!);
      }
      const fact = await createFact(citekey, {
        type: args.type as "statement" | "value" | "question" | "tag",
        input: String(args.input),
        answer: typeof args.answer === "string" ? args.answer : undefined,
        highlights,
        key: typeof args.key === "string" ? args.key : undefined,
        value: typeof args.value === "number" ? args.value : undefined,
        unit: typeof args.unit === "string" ? args.unit : undefined,
        createdBy: {
          kind: "agent",
          name: typeof args.agentName === "string" ? args.agentName : "mcp",
        },
      });
      if (fact.status === "confirmed") {
        // Spec: agent-made facts are always unreviewed — force if human-tag path auto-confirmed.
        const { updateFact } = await import("./facts.js");
        return {
          fact: await updateFact(citekey, fact.id, { status: "unreviewed" }),
        };
      }
      return { fact };
    }
    case "knowledge_list": {
      const { listKnowledgeItems } = await import("../knowledge/items.js");
      return { items: await listKnowledgeItems() };
    }
    case "knowledge_get": {
      const { listKnowledgeItems } = await import("../knowledge/items.js");
      const { listStepStatuses } = await import("../knowledge/review.js");
      const items = await listKnowledgeItems();
      const item =
        items.find((i) => i.knowledgeId === args.knowledgeId || i.id === args.projectId) ?? null;
      if (!item) throw Object.assign(new Error("Knowledge item not found"), { status: 404 });
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const { getProjectsRootAbs } = await import("../../config.js");
      const tex = await fs.readFile(path.join(getProjectsRootAbs(), item.id, "main.tex"), "utf8");
      const steps = await listStepStatuses(item.id);
      return { item, tex, steps };
    }
    case "knowledge_create": {
      const { createKnowledgeItem } = await import("../knowledge/items.js");
      return createKnowledgeItem({
        title: String(args.title),
        collection: typeof args.collection === "string" ? args.collection : undefined,
      });
    }
    case "knowledge_check": {
      const { prepareKnowledgeCompile } = await import("../knowledge/prepareCompile.js");
      const { listStepStatuses } = await import("../knowledge/review.js");
      const projectId = String(args.projectId);
      const prepared = await prepareKnowledgeCompile(projectId);
      const steps = await listStepStatuses(projectId);
      return { errors: prepared.errors, steps, usesKnowledge: prepared.usesKnowledge };
    }
    case "graph_neighborhood": {
      const { buildKnowledgeGraph } = await import("../knowledge/graph.js");
      const graph = await buildKnowledgeGraph();
      const start = String(args.node);
      const depth = typeof args.depth === "number" ? Math.max(0, Math.min(8, args.depth)) : 1;
      const keep = new Set<string>([start]);
      let frontier = new Set<string>([start]);
      for (let d = 0; d < depth; d += 1) {
        const next = new Set<string>();
        for (const e of graph.edges) {
          if (frontier.has(e.from) && !keep.has(e.to)) {
            keep.add(e.to);
            next.add(e.to);
          }
          if (frontier.has(e.to) && !keep.has(e.from)) {
            keep.add(e.from);
            next.add(e.from);
          }
        }
        frontier = next;
      }
      return {
        nodes: graph.nodes.filter((n) => keep.has(n.id)),
        edges: graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
      };
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { status: 400 });
  }
}

/** Tool names that would verify — must stay empty forever. */
export const VERIFICATION_TOOL_NAMES = [
  "fact_confirm",
  "fact_reject",
  "knowledge_review",
  "step_review",
  "confirm_fact",
  "reject_fact",
] as const;

export function libraryMcpToolNames(): string[] {
  return TOOLS.map((t) => t.name);
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
