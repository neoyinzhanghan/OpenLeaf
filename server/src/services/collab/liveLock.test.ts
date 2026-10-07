/**
 * A blocked client must not land text in the shared doc or on disk, even when
 * its updates are pipelined with the owner's. These assertions fail on 2a4356e,
 * which applies the update before the access check.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import * as Y from "yjs";
import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-livelock-"));
const configDir = path.join(sandbox, "config");
const projects = path.join(sandbox, "projects");
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(projects, { recursive: true });
fs.copyFileSync(path.resolve(here, "../../../../config/default.json"), path.join(configDir, "default.json"));
fs.writeFileSync(
  path.join(configDir, "local.json"),
  `${JSON.stringify({ allowedHosts: ["127.0.0.2"] })}\n`,
);
process.env.OPENLEAF_CONFIG_DIR = configDir;
process.env.OPENLEAF_HOST_AUTH_DIR = configDir;
process.env.OPENLEAF_PROJECTS_ROOT = projects;
process.env.OPENLEAF_HOST_GATEWAY = "0";
process.env.OPENLEAF_CLOUDFLARED = path.resolve(here, "../../../../e2e/fake-cloudflared.sh");

const { loadConfig } = await import("../../config.js");
loadConfig(true);
const { attachCollabServer } = await import("./server.js");
const { flushProjectRoom, getRoom } = await import("./room.js");
const { ensureHostAuth, mintHostToken, HOST_COOKIE } = await import("../hostAuth.js");
const { startShare, stopAllShares, guestLogin } = await import("../share.js");
const { GUEST_COOKIE } = await import("../shareAuth.js");

ensureHostAuth();
const deviceCookie = `${HOST_COOKIE}=${encodeURIComponent(mintHostToken())}`;

const IDENTITIES = [
  { id: "owner", name: "Owner", color: "#0F766E" },
  { id: "phone", name: "Phone", color: "#7C3AED" },
];

function writeProject(id: string): string {
  const dir = path.join(projects, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "main.tex"), "BASE\n");
  fs.writeFileSync(
    path.join(dir, "openleaf.json"),
    `${JSON.stringify(
      {
        mainFile: "main.tex",
        engine: "pdflatex",
        identities: IDENTITIES,
        fileAccess: {
          rules: [
            {
              path: "main.tex",
              level: "local",
              setBy: "local",
              setAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  return dir;
}

async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  const server = http.createServer(app);
  const wss = attachCollabServer(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise((resolve, reject) => {
        wss.close();
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function socketFor(headers: Record<string, string>) {
  return class extends WebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, { headers, closeTimeout: 20 });
    }

    override close(): void {
      this.terminate();
    }
  };
}

function connect(
  port: number,
  projectId: string,
  identityId: string,
  headers?: Record<string, string>,
): { doc: Y.Doc; provider: WebsocketProvider } {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/collab`, projectId, doc, {
    WebSocketPolyfill: socketFor(headers ?? {}) as unknown as typeof globalThis.WebSocket,
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

async function whenFile(doc: Y.Doc): Promise<Y.Text> {
  const existing = doc.getMap("files").get("main.tex");
  if (existing instanceof Y.Text) return existing;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for main.tex")), 8000);
    const map = doc.getMap("files");
    const obs = () => {
      const text = map.get("main.tex");
      if (!(text instanceof Y.Text)) return;
      clearTimeout(timer);
      map.unobserve(obs);
      resolve(text);
    };
    map.observe(obs);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function burst(owner: Y.Text, blocked: Y.Text, gapMs: number): Promise<boolean> {
  let leaked = false;
  const watch = () => {
    if (owner.toString().includes("blocked-line")) leaked = true;
  };
  owner.observe(watch);
  for (let i = 0; i < 20; i += 1) {
    owner.insert(owner.length, `owner-line-${i}\n`);
    blocked.insert(blocked.length, `blocked-line-${i}\n`);
    if (gapMs > 0) await sleep(gapMs);
  }
  await sleep(gapMs > 0 ? 500 : 250);
  owner.unobserve(watch);
  return leaked;
}

function assertKept(text: string, disk: string): void {
  for (let i = 0; i < 20; i += 1) {
    assert.match(text, new RegExp(`owner-line-${i}\\b`), `owner doc missing owner-line-${i}`);
    assert.match(disk, new RegExp(`owner-line-${i}\\b`), `disk missing owner-line-${i}`);
  }
  assert.equal(text.includes("blocked-line"), false, "blocked text reached the owner doc");
  assert.equal(disk.includes("blocked-line"), false, "blocked text reached disk");
}

describe("live file locks over y-websocket", { concurrency: 1 }, () => {
  let server: Awaited<ReturnType<typeof listen>>;

  before(async () => {
    server = await listen();
  });

  after(async () => {
    stopAllShares();
    await server.close();
  });

  async function runCase(actor: "device" | "guest", gapMs: number): Promise<void> {
    const id = `lock-${actor}-${gapMs}`;
    const dir = writeProject(id);
    let headers: Record<string, string>;
    if (actor === "device") {
      headers = { Host: "127.0.0.2", Cookie: deviceCookie };
    } else {
      const share = await startShare(id, { branchId: "main", allowMainShare: true, expiresAt: null });
      const signed = guestLogin(
        share,
        { username: share.username, password: share.password, displayName: "Riley" },
        "127.0.0.1",
      );
      headers = { Host: share.hostname, Cookie: `${GUEST_COOKIE}=${signed.token}` };
    }
    const owner = connect(server.port, id, "owner");
    const blocked = connect(server.port, id, "phone", headers);
    try {
      await whenSynced(owner.provider, "owner");
      await whenSynced(blocked.provider, "blocked");
      const ownerText = await whenFile(owner.doc);
      const blockedText = await whenFile(blocked.doc);
      const leaked = await burst(ownerText, blockedText, gapMs);
      assert.equal(leaked, false, "owner saw blocked text before it was dropped");
      await flushProjectRoom(id, { commit: false });
      await sleep(100);
      assertKept(ownerText.toString(), fs.readFileSync(path.join(dir, "main.tex"), "utf8"));
    } finally {
      owner.provider.destroy();
      blocked.provider.destroy();
      await getRoom(id)?.destroy();
    }
  }

  it("drops a device burst with no delay while the owner types", async () => {
    await runCase("device", 0);
  });

  it("drops a device burst spaced 15 ms apart", async () => {
    await runCase("device", 15);
  });

  it("drops a guest burst with no delay while the owner types", async () => {
    await runCase("guest", 0);
  });
});
