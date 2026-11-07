/**
 * Streamable HTTP MCP front door for an AI collaborator token.
 * Same sandbox, quotas, and review hunks as /api/ai/v1 REST — JSON-RPC instead of routes.
 */
import crypto from "node:crypto";
import { z, ZodError } from "zod";
import { listAiReview } from "./aiReview.js";
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
  type AiAuth,
} from "./aiShare.js";
import { CommentAnchorSchema } from "./comments.js";

export { buildMcpConfigJson, mcpUrlFromApiBase } from "./aiPrompt.js";

export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MCP_PROTOCOL_VERSION = "2025-03-26";
export const MCP_SERVER_NAME = "openleaf-ai";
export const MCP_SERVER_VERSION = "1.0.0";

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

type JsonRpcId = string | number | null;
type JsonRpcMessage = {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export type McpJsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type McpHttpResult = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

type McpSession = { id: string; token: string; createdAt: number; lastSeen: number };

const sessions = new Map<string, McpSession>();

const str = z.string();
const bool = z.boolean().optional();
const intLine = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be an integer" });
    return z.NEVER;
  }
  return n;
});

type JsonSchema = Record<string, unknown>;

export type McpToolDef = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: "get_context",
    description: "Parent + sandbox tip hashes, dirty flag, file list, and quotas. Start here.",
    inputSchema: emptyObjectSchema(),
  },
  {
    name: "list_files",
    description: "List files in the AI sandbox worktree.",
    inputSchema: emptyObjectSchema(),
  },
  {
    name: "read_file",
    description: "Read a text file. Optional from/to are 1-indexed inclusive line numbers.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        from: { type: "integer", description: "1-indexed start line" },
        to: { type: "integer", description: "1-indexed end line (inclusive)" },
      },
      required: ["path"],
    },
  },
  {
    name: "edit",
    description:
      "Surgical unique substring replace (preferred). old must match uniquely unless replace_all is true. Empty old creates a missing/empty file. Aliases: old_string/new_string.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        old: { type: "string" },
        new: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path"],
    },
  },
  {
    name: "edit_range",
    description:
      "Replace an inclusive 1-indexed line span. endLine = startLine-1 inserts before startLine.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        startLine: { type: "integer" },
        endLine: { type: "integer" },
        content: { type: "string" },
      },
      required: ["path", "startLine", "endLine", "content"],
    },
  },
  {
    name: "apply_diff",
    description: "Apply a unified diff (---/+++ / @@ hunks). Rejected if context does not match.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        diff: { type: "string" },
        patch: { type: "string", description: "Alias of diff" },
      },
    },
  },
  {
    name: "write_file",
    description: "FULL file rewrite. Last resort: new files or tiny files only. Prefer edit.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "apply_patch",
    description: "FULL file rewrite per path. Last resort; not a unified diff. Prefer edit or apply_diff.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        patches: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
      },
      required: ["patches"],
    },
  },
  {
    name: "search",
    description: "Search tex/md/txt/bib in the sandbox.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { q: { type: "string" }, query: { type: "string" } },
    },
  },
  {
    name: "get_diff",
    description: "Changes vs the parent tip (what the human reviews).",
    inputSchema: emptyObjectSchema(),
  },
  {
    name: "get_review",
    description: "Pending hunks the human has not Accepted/Rejected yet.",
    inputSchema: emptyObjectSchema(),
  },
  {
    name: "compile",
    description: "Build the sandbox PDF (quota-limited).",
    inputSchema: emptyObjectSchema(),
  },
  {
    name: "commit",
    description: "Intentional commit on the AI sandbox only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
  {
    name: "list_comments",
    description: "List discussion threads shared with the host.",
    inputSchema: emptyObjectSchema(),
  },
  {
    name: "create_comment",
    description: "Start a thread on source (file + line) or add pdfPage/pdfX/pdfY for PDF.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        body: { type: "string" },
        anchor: {
          type: "object",
          properties: {
            file: { type: "string" },
            line: { type: "integer" },
            quote: { type: "string" },
            pdfPage: { type: "integer" },
            pdfX: { type: "number" },
            pdfY: { type: "number" },
          },
          required: ["file", "line"],
        },
      },
      required: ["body", "anchor"],
    },
  },
  {
    name: "reply_comment",
    description: "Reply in an existing comment thread.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { commentId: { type: "string", description: "Thread id" }, body: { type: "string" } },
      required: ["commentId", "body"],
    },
  },
  {
    name: "get_status",
    description: "waiting_for_human_review plus context.",
    inputSchema: emptyObjectSchema(),
  },
];

function emptyObjectSchema(): JsonSchema {
  return { type: "object", additionalProperties: false, properties: {} };
}

export function mcpToolNames(): string[] {
  return MCP_TOOLS.map((t) => t.name);
}

export function mcpInstructions(auth: AiAuth): string {
  const { ai } = auth;
  return [
    "You are an OpenLeaf branch editor connected over MCP.",
    `Parent branch “${ai.parentBranchName}” is read-only.`,
    `Write only on sandbox “${ai.branchName}”.`,
    "Prefer edit (unique substring) over rewriting a whole file. The human reviews green/red hunks — you cannot accept your own hunks.",
    "Never print the bearer token.",
  ].join(" ");
}

function pruneSessions(now = Date.now()): void {
  for (const [id, s] of sessions) {
    if (now - s.lastSeen > SESSION_TTL_MS) sessions.delete(id);
  }
}

export function clearMcpSessionsForTests(): void {
  sessions.clear();
}

function createSession(token: string): McpSession {
  pruneSessions();
  const session: McpSession = {
    id: `mcp-${crypto.randomBytes(12).toString("hex")}`,
    token,
    createdAt: Date.now(),
    lastSeen: Date.now(),
  };
  sessions.set(session.id, session);
  return session;
}

function touchSession(id: string, token: string): McpSession | "missing" | "mismatch" {
  pruneSessions();
  const s = sessions.get(id);
  if (!s) return "missing";
  if (s.token !== token) return "mismatch";
  s.lastSeen = Date.now();
  return s;
}

export function deleteMcpSession(id: string, token: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  if (s.token !== token) return false;
  sessions.delete(id);
  return true;
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): McpJsonRpcResponse {
  return { jsonrpc: "2.0", id, error: data !== undefined ? { code, message, data } : { code, message } };
}

function rpcResult(id: JsonRpcId, result: unknown): McpJsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function isNotification(msg: JsonRpcMessage): boolean {
  return !("id" in msg);
}

export function negotiateProtocol(requested: unknown): string {
  if (typeof requested === "string" && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested;
  }
  return MCP_PROTOCOL_VERSION;
}

function asArgs(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) return {};
  const p = params as { arguments?: unknown; name?: unknown };
  if (p.arguments && typeof p.arguments === "object" && !Array.isArray(p.arguments)) {
    return p.arguments as Record<string, unknown>;
  }
  return params as Record<string, unknown>;
}

function toolSuccess(data: unknown): Record<string, unknown> {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const structured =
    data !== null && typeof data === "object" ? (data as Record<string, unknown>) : { value: data };
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

async function dispatchTool(auth: AiAuth, name: string, raw: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "get_context":
      return aiGetContext(auth);
    case "list_files":
      return aiListFiles(auth);
    case "read_file": {
      const body = z
        .object({ path: str.min(1), from: intLine.optional(), to: intLine.optional() })
        .parse(raw);
      return aiReadFile(
        auth,
        body.path,
        body.from != null || body.to != null ? { from: body.from, to: body.to } : undefined,
      );
    }
    case "edit": {
      const body = z
        .object({
          path: str.min(1),
          old: str.optional(),
          new: str.optional(),
          old_string: str.optional(),
          new_string: str.optional(),
          replace_all: bool,
          replaceAll: bool,
        })
        .transform((v, ctx) => {
          const old = v.old ?? v.old_string;
          const neu = v.new ?? v.new_string;
          if (old === undefined || neu === undefined) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "old/new (or old_string/new_string) required" });
            return z.NEVER;
          }
          return { path: v.path, old, new: neu, replace_all: v.replace_all ?? v.replaceAll };
        })
        .parse(raw);
      return aiEdit(auth, body);
    }
    case "edit_range": {
      const body = z
        .object({ path: str.min(1), startLine: intLine, endLine: intLine, content: str })
        .parse(raw);
      return aiEditRange(auth, body);
    }
    case "apply_diff": {
      const body = z.object({ diff: str.optional(), patch: str.optional() }).parse(raw);
      const diff = body.diff ?? body.patch ?? "";
      return aiApplyUnifiedDiff(auth, diff);
    }
    case "write_file": {
      const body = z.object({ path: str.min(1), content: str }).parse(raw);
      return aiWriteFile(auth, body.path, body.content);
    }
    case "apply_patch": {
      const body = z
        .object({
          patches: z.array(z.object({ path: str.min(1), content: str })).min(1),
        })
        .parse(raw);
      return aiApplyPatch(auth, body.patches);
    }
    case "search": {
      const body = z.object({ q: str.optional(), query: str.optional() }).parse(raw);
      return aiSearch(auth, body.q ?? body.query ?? "");
    }
    case "get_diff":
      return aiDiff(auth);
    case "get_review":
      return listAiReview(aiReviewCtx(auth));
    case "compile":
      return aiCompile(auth);
    case "commit": {
      const body = z.object({ message: str }).parse(raw);
      return aiCommit(auth, body.message);
    }
    case "list_comments":
      return aiListComments(auth);
    case "create_comment": {
      const body = z.object({ body: str.min(1).max(8000), anchor: CommentAnchorSchema }).parse(raw);
      return aiCreateComment(auth, body);
    }
    case "reply_comment": {
      const body = z
        .object({ commentId: str.min(1), id: str.min(1).optional(), body: str.min(1).max(8000) })
        .parse(raw);
      return aiReplyComment(auth, body.commentId ?? body.id ?? "", body.body);
    }
    case "get_status":
      return aiStatus(auth);
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { status: 404, mcpUnknownTool: true });
  }
}

async function handleSingle(
  auth: AiAuth,
  msg: JsonRpcMessage,
  ctx: { sessionId?: string; createdSession?: McpSession },
): Promise<McpJsonRpcResponse | null> {
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    const id = "id" in msg ? (msg.id as JsonRpcId) ?? null : null;
    return rpcError(id, -32600, "Invalid Request");
  }
  const method = msg.method;
  const id = isNotification(msg) ? undefined : ((msg.id as JsonRpcId) ?? null);
  const note = isNotification(msg);

  if (method === "notifications/initialized" || method === "initialized") {
    return null;
  }
  if (note) return null;

  const reqId = id as JsonRpcId;

  if (method === "initialize") {
    const params = msg.params && typeof msg.params === "object" ? (msg.params as Record<string, unknown>) : {};
    const protocolVersion = negotiateProtocol(params.protocolVersion);
    const session = createSession(auth.ai.token);
    ctx.createdSession = session;
    ctx.sessionId = session.id;
    return rpcResult(reqId, {
      protocolVersion,
      capabilities: {
        tools: { listChanged: false },
        prompts: { listChanged: false },
      },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      instructions: mcpInstructions(auth),
    });
  }

  if (method === "ping") return rpcResult(reqId, {});
  if (method === "logging/setLevel") return rpcResult(reqId, {});

  if (method === "tools/list") {
    return rpcResult(reqId, { tools: MCP_TOOLS });
  }

  if (method === "tools/call") {
    const params = msg.params && typeof msg.params === "object" ? (msg.params as Record<string, unknown>) : {};
    const name = typeof params.name === "string" ? params.name : "";
    if (!name) return rpcError(reqId, -32602, "tools/call requires params.name");
    try {
      const data = await dispatchTool(auth, name, asArgs(params));
      return rpcResult(reqId, toolSuccess(data));
    } catch (err) {
      if (err && typeof err === "object" && "mcpUnknownTool" in err) {
        return rpcError(reqId, -32602, err instanceof Error ? err.message : "Unknown tool");
      }
      if (err instanceof ZodError) {
        const issue = err.issues[0];
        const path = issue?.path?.filter(Boolean).join(".") ?? "";
        const message = path ? `${path}: ${issue?.message}` : issue?.message || "Invalid arguments";
        return rpcResult(reqId, toolFailure(message));
      }
      return rpcResult(reqId, toolFailure(err instanceof Error ? err.message : "Tool failed"));
    }
  }

  if (method === "prompts/list") {
    return rpcResult(reqId, {
      prompts: [
        {
          name: "openleaf_briefing",
          title: "OpenLeaf AI collaborator",
          description: "Sandbox rules: parent is read-only; write only on the AI fork.",
        },
      ],
    });
  }

  if (method === "prompts/get") {
    const params = msg.params && typeof msg.params === "object" ? (msg.params as { name?: unknown }) : {};
    const name = typeof params.name === "string" ? params.name : "openleaf_briefing";
    if (name !== "openleaf_briefing") return rpcError(reqId, -32602, `Unknown prompt: ${name}`);
    return rpcResult(reqId, {
      description: "OpenLeaf AI sandbox briefing",
      messages: [{ role: "user", content: { type: "text", text: mcpInstructions(auth) } }],
    });
  }

  if (method === "resources/list") {
    return rpcResult(reqId, { resources: [] });
  }
  if (method === "resources/templates/list") {
    return rpcResult(reqId, { resourceTemplates: [] });
  }

  return rpcError(reqId, -32601, `Method not found: ${method}`);
}

/**
 * Handle one JSON-RPC object or a batch array. Notifications yield no response entry.
 */
export async function handleMcpRpc(
  auth: AiAuth,
  body: unknown,
  opts?: { sessionId?: string },
): Promise<{ sessionId?: string; responses: McpJsonRpcResponse[] | McpJsonRpcResponse | null; notificationOnly: boolean }> {
  const ctx: { sessionId?: string; createdSession?: McpSession } = { sessionId: opts?.sessionId };

  const messages: JsonRpcMessage[] = Array.isArray(body) ? body : [body as JsonRpcMessage];
  if (messages.length === 0 || body == null || (typeof body !== "object" && !Array.isArray(body))) {
    return {
      responses: rpcError(null, -32600, "Invalid Request"),
      notificationOnly: false,
    };
  }

  const out: McpJsonRpcResponse[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      out.push(rpcError(null, -32600, "Invalid Request"));
      continue;
    }
    const resp = await handleSingle(auth, msg, ctx);
    if (resp) out.push(resp);
  }

  const sessionId = ctx.createdSession?.id ?? ctx.sessionId;
  if (out.length === 0) {
    return { sessionId, responses: null, notificationOnly: true };
  }
  if (!Array.isArray(body) && out.length === 1) {
    return { sessionId, responses: out[0]!, notificationOnly: false };
  }
  return { sessionId, responses: out, notificationOnly: false };
}

function isInitializePayload(body: unknown): boolean {
  if (Array.isArray(body)) return body.some(isInitializePayload);
  return Boolean(body && typeof body === "object" && (body as { method?: unknown }).method === "initialize");
}

function originLooksValid(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "cursor:" || u.protocol === "vscode-file:";
  } catch {
    return false;
  }
}

/** Full HTTP mapping for POST/GET/DELETE /mcp (Bearer already resolved). */
export async function handleMcpHttp(opts: {
  method: string;
  auth: AiAuth;
  body: unknown;
  sessionId?: string;
  origin?: string;
  accept?: string;
}): Promise<McpHttpResult> {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
  };

  if (!originLooksValid(opts.origin)) {
    return {
      status: 403,
      headers: { ...headers, "Content-Type": "application/json" },
      body: rpcError(null, -32000, "Forbidden Origin"),
    };
  }

  const method = opts.method.toUpperCase();

  if (method === "DELETE") {
    const sid = opts.sessionId?.trim();
    if (!sid) {
      return { status: 400, headers: { "Content-Type": "application/json" }, body: { error: "Mcp-Session-Id required" } };
    }
    deleteMcpSession(sid, opts.auth.ai.token);
    return { status: 204, headers, body: null };
  }

  if (method === "GET") {
    return {
      status: 405,
      headers: { ...headers, Allow: "POST, DELETE, OPTIONS", "Content-Type": "application/json" },
      body: rpcError(null, -32000, "Use POST JSON-RPC; SSE GET is not required for this server"),
    };
  }

  if (method !== "POST") {
    return {
      status: 405,
      headers: { ...headers, Allow: "POST, DELETE, OPTIONS", "Content-Type": "application/json" },
      body: rpcError(null, -32000, "Method not allowed"),
    };
  }

  if (opts.sessionId && !isInitializePayload(opts.body)) {
    const hit = touchSession(opts.sessionId, opts.auth.ai.token);
    if (hit === "missing" || hit === "mismatch") {
      return {
        status: 404,
        headers: { "Content-Type": "application/json" },
        body: rpcError(null, -32001, "Session not found"),
      };
    }
  }

  const handled = await handleMcpRpc(opts.auth, opts.body, { sessionId: opts.sessionId });
  if (handled.sessionId) headers["Mcp-Session-Id"] = handled.sessionId;
  headers["MCP-Protocol-Version"] = MCP_PROTOCOL_VERSION;

  if (handled.notificationOnly) {
    return { status: 202, headers, body: null };
  }

  const accept = opts.accept ?? "";
  const wantsSse = accept.includes("text/event-stream") && !accept.includes("application/json");
  if (wantsSse) {
    const payload = JSON.stringify(handled.responses);
    return {
      status: 200,
      headers: { ...headers, "Content-Type": "text/event-stream" },
      body: `event: message\ndata: ${payload}\n\n`,
    };
  }

  return {
    status: 200,
    headers: { ...headers, "Content-Type": "application/json" },
    body: handled.responses,
  };
}
