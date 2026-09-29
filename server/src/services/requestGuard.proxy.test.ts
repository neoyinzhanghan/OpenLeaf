import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import express from "express";
import { shareGate } from "./shareAuth.js";

/**
 * Stand-in for Vite's xfwd: append the socket peer to X-Forwarded-For and
 * rewrite Host to 127.0.0.1 (changeOrigin).
 */
function listenProxy(apiPort: number): Promise<{ port: number; close: () => Promise<void> }> {
  const proxy = http.createServer((req, res) => {
    const peer = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const prior = req.headers["x-forwarded-for"];
    const xff = prior ? `${prior}, ${peer}` : peer;
    const headers = { ...req.headers, host: "127.0.0.1", "x-forwarded-for": xff };
    const upstream = http.request(
      { host: "127.0.0.1", port: apiPort, method: req.method, path: req.url, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 500, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.statusCode = 502;
      res.end();
    });
    req.pipe(upstream);
  });
  return new Promise((resolve) => {
    proxy.listen(0, "127.0.0.2", () => {
      const port = (proxy.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise((done, reject) => {
            proxy.close((err) => (err ? reject(err) : done()));
          }),
      });
    });
  });
}

describe("dev proxy forwarded IP", () => {
  const closers: Array<() => Promise<void>> = [];
  after(async () => {
    for (const close of closers) await close();
  });

  it("does not treat a forged X-Forwarded-For as the loopback owner", async () => {
    const app = express();
    app.use(shareGate);
    app.get("/api/projects", (_req, res) => {
      res.json({ ok: true });
    });
    const api = http.createServer(app);
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const apiPort = (api.address() as AddressInfo).port;
    closers.push(
      () =>
        new Promise((done, reject) => {
          api.close((err) => (err ? reject(err) : done()));
        }),
    );
    const proxy = await listenProxy(apiPort);
    closers.push(proxy.close);

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.2",
          localAddress: "127.0.0.2",
          port: proxy.port,
          method: "GET",
          path: "/api/projects",
          headers: { Host: "127.0.0.2", "X-Forwarded-For": "127.0.0.1" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 401);
  });
});
