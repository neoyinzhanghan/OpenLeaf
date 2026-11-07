import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

// This surface (libraryAiShare.ts / libraryAiMcp.ts / routes/libraryAi.ts) had
// NO test coverage before this audit, unlike its pre-existing model aiShare.ts
// / aiMcp.ts. It's the highest-risk surface in the citation-library feature
// (auth + AI + outbound network), so cover the auth-gate regression this
// audit found and fixed: /lookup and /verify (both REST and MCP) must honor
// allowSearch=false the same way /search, /recent, and /papers/:citekey do.

const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-ai-mcp-lib-"));
const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-ai-mcp-proj-"));
process.env.OPENLEAF_LIBRARY_ROOT = libraryRoot;
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;

const { loadConfig } = await import("../config.js");
loadConfig(true);

const { closeIndexDb, reindexLibrary } = await import("./library/index.js");
const { mintLibraryAi, resolveLibraryAiToken, revokeLibraryAi } = await import("./libraryAiShare.js");
const { handleLibraryAiMcpHttp } = await import("./libraryAiMcp.js");
const { libraryAiApiRouter } = await import("../routes/libraryAi.js");
const { handleLibraryMcpHttp } = await import("./library/libraryMcp.js");
const { assertLibraryAiOutbound, LIBRARY_AI_OUTBOUND_LIMIT, resetLibraryAiOutboundLimitsForTests } =
  await import("./libraryAiOutboundLimit.js");

describe("library AI MCP — search-disabled links cannot lookup/verify", () => {
  let server: http.Server;
  let port = 0;

  before(async () => {
    await reindexLibrary();
    const app = express();
    app.use(express.json());
    app.use(libraryAiApiRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("test server has no port");
    port = addr.port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeIndexDb();
    fs.rmSync(libraryRoot, { recursive: true, force: true });
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
    const auth = resolveLibraryAiToken(token);
    assert.ok(auth, "expected a resolvable session");
    const res = await handleLibraryAiMcpHttp(auth!, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const body = res.body as {
      result: { isError: boolean; structuredContent: unknown };
    };
    return body.result;
  }

  it("rejects library_lookup when allowSearch is false, with no external call attempted", async () => {
    const { session } = mintLibraryAi({
      settings: { allowSearch: false, allowAdd: false, allowEnrich: false },
      riskAck: true,
    });
    try {
      const result = await callTool(session.token, "library_lookup", { doi: "10.1234/does-not-matter" });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.structuredContent), /disabled/i);
    } finally {
      revokeLibraryAi(session.id);
    }
  });

  it("rejects library_verify when allowSearch is false, with no external call attempted", async () => {
    const { session } = mintLibraryAi({
      settings: { allowSearch: false, allowAdd: false, allowEnrich: false },
      riskAck: true,
    });
    try {
      const result = await callTool(session.token, "library_verify", {
        title: "Some Paper",
        doi: "10.1234/does-not-matter",
      });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.structuredContent), /disabled/i);
    } finally {
      revokeLibraryAi(session.id);
    }
  });

  it("rate-limits library_lookup on a Bearer link before any outbound lookup", async () => {
    const { session } = mintLibraryAi({
      settings: { allowSearch: true, allowAdd: false, allowEnrich: false },
      riskAck: true,
    });
    try {
      for (let i = 0; i < LIBRARY_AI_OUTBOUND_LIMIT; i += 1) assertLibraryAiOutbound(session.id);
      const result = await callTool(session.token, "library_lookup", { url: "https://example.com/not-a-doi" });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.structuredContent), /too many/i);
    } finally {
      resetLibraryAiOutboundLimitsForTests();
      revokeLibraryAi(session.id);
    }
  });

  it("host-local library_lookup has no allowSearch gate and still answers", async () => {
    const res = await handleLibraryMcpHttp({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "library_lookup", arguments: { url: "https://example.com/not-a-doi" } },
    });
    const body = res.body as { result?: { structuredContent?: { paper?: unknown } }; error?: { message?: string } };
    assert.equal(body.error, undefined);
    assert.equal(body.result?.structuredContent?.paper ?? null, null);
    assert.doesNotMatch(JSON.stringify(body), /disabled/i);
  });

  it("still allows library_search when allowSearch is true (no regression)", async () => {
    const { session } = mintLibraryAi({
      settings: { allowSearch: true, allowAdd: false, allowEnrich: false },
      riskAck: true,
    });
    try {
      const result = await callTool(session.token, "library_search", { query: "" });
      assert.equal(result.isError, false);
    } finally {
      revokeLibraryAi(session.id);
    }
  });

  it("echoes a supported initialize protocol version", async () => {
    const { session } = mintLibraryAi({
      settings: { allowSearch: true, allowAdd: false, allowEnrich: false },
      riskAck: true,
    });
    try {
      const auth = resolveLibraryAiToken(session.token);
      assert.ok(auth);
      const res = await handleLibraryAiMcpHttp(auth!, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude", version: "1" } },
      });
      const body = res.body as { result: { protocolVersion: string } };
      assert.equal(body.result.protocolVersion, "2025-06-18");
      assert.equal(res.headers["MCP-Protocol-Version"], "2025-06-18");
    } finally {
      revokeLibraryAi(session.id);
    }
  });

  it("falls back when initialize asks for an unknown protocol version", async () => {
    const { session } = mintLibraryAi({
      settings: { allowSearch: true, allowAdd: false, allowEnrich: false },
      riskAck: true,
    });
    try {
      const auth = resolveLibraryAiToken(session.token);
      assert.ok(auth);
      const res = await handleLibraryAiMcpHttp(auth!, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "1999-01-01" },
      });
      const body = res.body as { result: { protocolVersion: string } };
      assert.equal(body.result.protocolVersion, "2025-03-26");
    } finally {
      revokeLibraryAi(session.id);
    }
  });

  it("answers an unauthenticated GET with 401 and a Bearer challenge", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer /);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "LIBRARY_AI_AUTH");
  });

  it("answers an authenticated GET with 405 Allow POST", async () => {
    const { session } = mintLibraryAi({
      settings: { allowSearch: true, allowAdd: false, allowEnrich: false },
      riskAck: true,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        headers: { Authorization: `Bearer ${session.token}` },
      });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "POST");
      const body = (await res.json()) as { error?: { code?: number } };
      assert.equal(body.error?.code, -32000);
    } finally {
      revokeLibraryAi(session.id);
    }
  });
});
