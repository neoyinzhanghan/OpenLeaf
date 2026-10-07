import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-mcp-lib-"));
process.env.OPENLEAF_LIBRARY_ROOT = libraryRoot;

const { loadConfig } = await import("../../config.js");
loadConfig(true);

const { addPaper, closeIndexDb, reindexLibrary } = await import("./index.js");
const { handleLibraryMcpHttp } = await import("./libraryMcp.js");

describe("library MCP", () => {
  before(async () => {
    await reindexLibrary();
    await addPaper({
      citekey: "mcp2024test",
      title: "MCP Test Paper About Attention",
      authors: [{ given: "Ada", family: "Lovelace" }],
      year: 2024,
      tags: ["mcp"],
    });
  });

  after(() => {
    closeIndexDb();
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  });

  it("lists tools and searches the library", async () => {
    const init = await handleLibraryMcpHttp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    assert.equal(init.status, 200);

    const listed = await handleLibraryMcpHttp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const tools = (listed.body as { result: { tools: Array<{ name: string }> } }).result.tools;
    assert.ok(tools.some((t) => t.name === "library_search"));
    assert.equal(tools.length, 8);

    const search = await handleLibraryMcpHttp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "library_search", arguments: { query: "attention" } },
    });
    const text = (search.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    assert.match(text, /mcp2024test/);
  });

  it("gets a paper by citekey", async () => {
    const got = await handleLibraryMcpHttp({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "library_get", arguments: { citekey: "mcp2024test" } },
    });
    const text = (got.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    assert.match(text, /MCP Test Paper/);
  });
});
