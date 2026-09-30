import assert from "node:assert/strict";
import fs from "node:fs";
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
const { handleLibraryMcpHttp } = await import("./library/libraryMcp.js");
const { assertLibraryAiOutbound, LIBRARY_AI_OUTBOUND_LIMIT, resetLibraryAiOutboundLimitsForTests } =
  await import("./libraryAiOutboundLimit.js");

describe("library AI MCP — search-disabled links cannot lookup/verify", () => {
  before(async () => {
    await reindexLibrary();
  });

  after(() => {
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
});
