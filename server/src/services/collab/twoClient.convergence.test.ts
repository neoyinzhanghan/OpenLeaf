import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import * as Y from "yjs";
import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-twoclient-"));
const configDir = path.join(sandbox, "config");
const projects = path.join(sandbox, "projects");
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(projects, { recursive: true });
fs.copyFileSync(path.resolve(here, "../../../../config/default.json"), path.join(configDir, "default.json"));
process.env.OPENLEAF_CONFIG_DIR = configDir;
process.env.OPENLEAF_PROJECTS_ROOT = projects;
process.env.OPENLEAF_HOST_GATEWAY = "0";

const { loadConfig } = await import("../../config.js");
loadConfig(true);
const { attachCollabServer } = await import("./server.js");
const { flushProjectRoom, getRoom } = await import("./room.js");

const IDENTITIES = [
  { id: "test-user", name: "Test User", color: "#0F766E" },
  { id: "alice", name: "Alice", color: "#7C3AED" },
];

function writeProject(id: string, tex: string): string {
  const dir = path.join(projects, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "main.tex"), tex);
  fs.writeFileSync(
    path.join(dir, "openleaf.json"),
    `${JSON.stringify({ mainFile: "main.tex", engine: "pdflatex", identities: IDENTITIES }, null, 2)}\n`,
  );
  return dir;
}

async function listen(): Promise<{
  port: number;
  closeAllConnections: () => void;
  close: () => Promise<void>;
}> {
  const app = express();
  const server = http.createServer(app);
  const wss = attachCollabServer(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    closeAllConnections: () => {
      wss.close();
      server.closeAllConnections();
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.unref();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

class TestSocket extends WebSocket {
  constructor(url: string, protocols?: string | string[]) {
    super(url, protocols, { closeTimeout: 20 });
  }

  override close(): void {
    this.terminate();
  }
}

function connect(port: number, projectId: string, identityId: string): { doc: Y.Doc; provider: WebsocketProvider } {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, projectId, doc, {
    WebSocketPolyfill: TestSocket as unknown as typeof globalThis.WebSocket,
    params: { identity: identityId, branch: "main" },
    disableBc: true,
  });
  return { doc, provider };
}

function whenSynced(provider: WebsocketProvider, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} collab sync timed out (connected=${String(provider.wsconnected)})`));
    }, 8000);
    const done = (synced: boolean) => {
      if (!synced) return;
      clearTimeout(timer);
      resolve();
    };
    provider.on("sync", done);
    if (provider.synced) done(true);
  });
}

function fileText(doc: Y.Doc, rel = "main.tex"): Y.Text | undefined {
  const value = doc.getMap("files").get(rel);
  return value instanceof Y.Text ? value : undefined;
}

async function whenFile(doc: Y.Doc, rel = "main.tex"): Promise<Y.Text> {
  const existing = fileText(doc, rel);
  if (existing) return existing;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${rel}`)), 8000);
    const map = doc.getMap("files");
    const obs = () => {
      const text = fileText(doc, rel);
      if (!text) return;
      clearTimeout(timer);
      map.unobserve(obs);
      resolve(text);
    };
    map.observe(obs);
  });
}

async function until(label: string, pred: () => boolean): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > 8000) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("two collab clients", () => {
  after(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("converges interleaved and concurrent inserts onto one file", async () => {
    const id = "pair";
    const dir = writeProject(id, "BASE\n");
    const server = await listen();
    const a = connect(server.port, id, "test-user");
    const c = connect(server.port, id, "alice");
    try {
      await Promise.all([whenSynced(a.provider, "A"), whenSynced(c.provider, "C")]);
      const textA = await whenFile(a.doc);
      const textC = await whenFile(c.doc);
      assert.equal(textA.toString(), "BASE\n");
      assert.equal(textC.toString(), "BASE\n");

      textC.insert(0, "% from-C\n");
      await until("A sees from-C", () => textA.toString().includes("% from-C"));

      textA.insert(0, "% from-A\n");
      await until("C sees from-A", () => textC.toString().includes("% from-A"));
      await until("docs match after sequential edits", () => textA.toString() === textC.toString());

      const endA = "% end-A\n";
      const endC = "% end-C\n";
      textA.insert(textA.length, endA);
      textC.insert(textC.length, endC);
      await until("docs match after concurrent edits", () => textA.toString() === textC.toString());

      const shared = textA.toString();
      assert.match(shared, /% from-A/);
      assert.match(shared, /% from-C/);
      assert.match(shared, /% end-A/);
      assert.match(shared, /% end-C/);
      assert.match(shared, /BASE/);

      await flushProjectRoom(id, { commit: false });
      const disk = fs.readFileSync(path.join(dir, "main.tex"), "utf8");
      assert.equal(disk, shared);
    } finally {
      a.provider.destroy();
      c.provider.destroy();
      await getRoom(id)?.destroy();
      server.closeAllConnections();
      await server.close();
    }
  });
});
