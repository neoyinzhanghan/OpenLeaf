import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-mcp-lib-"));
const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-mcp-proj-"));
process.env.OPENLEAF_LIBRARY_ROOT = libraryRoot;
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;
process.env.OPENLEAF_ALLOW_PRIVATE_FETCH = "1";

const { loadConfig } = await import("../../config.js");
loadConfig(true);

const { handleLibraryMcpHttp, libraryMcpToolNames, VERIFICATION_TOOL_NAMES } = await import(
  "./libraryMcp.js"
);
const { reindexLibrary, closeIndexDb } = await import("./index.js");

describe("library MCP knowledge tools", () => {
  let pageServer: http.Server;
  let pageUrl = "";

  before(async () => {
    await reindexLibrary();
    pageServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><title>DEMO MCP Page</title><body><p>The fee is 99 USD exactly.</p></body></html>");
    });
    await new Promise<void>((r) => pageServer.listen(0, "127.0.0.1", () => r()));
    const addr = pageServer.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    pageUrl = `http://127.0.0.1:${addr.port}/`;
  });

  after(async () => {
    closeIndexDb();
    await new Promise<void>((resolve, reject) => pageServer.close((e) => (e ? reject(e) : resolve())));
    fs.rmSync(libraryRoot, { recursive: true, force: true });
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("lists no verification tools", () => {
    const names = libraryMcpToolNames();
    for (const banned of VERIFICATION_TOOL_NAMES) {
      assert.equal(names.includes(banned), false);
    }
    assert.ok(names.includes("fact_propose"));
    assert.ok(names.includes("source_add_web"));
  });

  it("proposes unreviewed agent facts with quote verification", async () => {
    const add = await handleLibraryMcpHttp({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "source_add_web", arguments: { url: pageUrl } },
    });
    assert.equal(add.status, 200);
    const addBody = add.body as { result?: { structuredContent?: { citekey: string } } };
    const citekey = addBody.result?.structuredContent?.citekey;
    assert.ok(citekey);

    const bad = await handleLibraryMcpHttp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "fact_propose",
        arguments: {
          citekey,
          type: "value",
          input: "Fee",
          answer: "99",
          quotes: ["this quote is not on the page"],
          agentName: "test-agent",
        },
      },
    });
    assert.equal(bad.status, 200);
    assert.ok((bad.body as { error?: { message?: string } }).error?.message);

    const ok = await handleLibraryMcpHttp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "fact_propose",
        arguments: {
          citekey,
          type: "value",
          input: "Fee",
          answer: "99",
          quotes: ["The fee is 99 USD exactly."],
          agentName: "test-agent",
        },
      },
    });
    const fact = (ok.body as { result?: { structuredContent?: { fact: { status: string; createdBy?: { kind: string } } } } })
      .result?.structuredContent?.fact;
    assert.ok(fact);
    assert.equal(fact.status, "unreviewed");
    assert.equal(fact.createdBy?.kind, "agent");
  });
});
