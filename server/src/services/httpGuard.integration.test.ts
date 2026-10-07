import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import express from "express";
import { WebSocket } from "ws";
import { attachCollabServer } from "./collab/server.js";
import { shareGate } from "./shareAuth.js";

function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(shareGate);
  app.get("/api/projects", (_req, res) => {
    res.json({ ok: true });
  });
  app.put("/api/projects/demo/files/main.tex", (_req, res) => {
    res.json({ ok: true });
  });
  const server = http.createServer(app);
  attachCollabServer(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("HTTP guard", () => {
  it("does not grant CORS to another site, and rejects a bad Host and a cross-origin write", async () => {
    const server = await listen();
    try {
      const listed = await rawRequest(server.port, "GET", "/api/projects", {
        Host: "127.0.0.1",
        Origin: "https://evil.example",
      });
      assert.equal(listed.headers["access-control-allow-origin"], undefined);
      assert.equal(listed.status, 403);

      const put = await rawRequest(server.port, "PUT", "/api/projects/demo/files/main.tex", {
        Host: "127.0.0.1",
        Origin: "https://evil.example",
      });
      assert.equal(put.status, 403);

      const badHost = await rawRequest(server.port, "GET", "/api/projects", { Host: "attacker.example" });
      assert.equal(badHost.status, 421);

      const upgrade = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/collab/demo?identity=author`, {
          headers: { Origin: "https://evil.example", Host: "127.0.0.1" },
        });
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("open", () => resolve(101));
        ws.on("error", (err) => reject(err));
      });
      assert.equal(upgrade, 403);
    } finally {
      await server.close();
    }
  });
});
