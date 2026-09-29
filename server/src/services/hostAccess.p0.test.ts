import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-host-p0-"));
const configDir = path.join(sandbox, "config");
fs.mkdirSync(configDir, { recursive: true });
fs.copyFileSync(path.resolve(here, "../../../config/default.json"), path.join(configDir, "default.json"));
process.env.OPENLEAF_CONFIG_DIR = configDir;
process.env.OPENLEAF_HOST_AUTH_DIR = configDir;
process.env.OPENLEAF_PROJECTS_ROOT = path.join(sandbox, "projects");
process.env.OPENLEAF_HOST_GATEWAY = "0";
fs.mkdirSync(process.env.OPENLEAF_PROJECTS_ROOT, { recursive: true });

const { loadConfig } = await import("../config.js");
loadConfig(true);
const { ensureHostAuth, HOST_COOKIE } = await import("./hostAuth.js");
const { createPasswordDevice, createPairing, listDevices } = await import("./hostDevices.js");
const { configRouter } = await import("../routes/config.js");
const { pairRouter } = await import("../routes/host.js");
const { guestRouter } = await import("../routes/guest.js");
const { shareGate } = await import("./shareAuth.js");

ensureHostAuth();
const device = createPasswordDevice({ userAgent: "Mozilla iPhone Safari", ip: "127.0.0.1" });
const cookie = `${HOST_COOKIE}=${encodeURIComponent(device.sessionToken)}`;

function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise((done, reject) => {
            server.close((err) => (err ? reject(err) : done()));
          }),
      });
    });
  });
}

function request(
  port: number,
  method: string,
  reqPath: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: reqPath, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("remote host access", () => {
  after(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("lets a paired device change a harmless setting and refuses machine settings", async () => {
    const app = express();
    app.use(express.json());
    app.use(shareGate);
    app.use("/api/config", configRouter);
    const server = await listen(app);
    try {
      const remote = {
        Host: "127.0.0.1",
        Origin: "http://127.0.0.1",
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-Forwarded-For": "10.1.2.3",
      };
      const protectedBodies = [
        { lanAuth: "open" },
        { allowedHosts: ["evil.example"] },
        { access: "remote" },
        { host: "0.0.0.0" },
        { port: 9 },
        { projectsRoot: "/tmp" },
        { libraryRoot: "/tmp" },
        { latex: { allowProjectLatexmkrc: true } },
        { latex: { paranoidFileAccess: false } },
        { git: { enabled: false } },
      ];
      for (const body of protectedBodies) {
        const blocked = await request(server.port, "PATCH", "/api/config", remote, JSON.stringify(body));
        assert.equal(blocked.status, 403, JSON.stringify(body));
      }

      const allowed = await request(
        server.port,
        "PATCH",
        "/api/config",
        remote,
        JSON.stringify({ user: { displayName: "Remote" } }),
      );
      assert.equal(allowed.status, 200);

      const owner = await request(
        server.port,
        "PATCH",
        "/api/config",
        { Host: "127.0.0.1", Origin: "http://127.0.0.1", "Content-Type": "application/json" },
        JSON.stringify({ lanAuth: "device" }),
      );
      assert.equal(owner.status, 200);
    } finally {
      await server.close();
    }
  });

  it("does not redeem a pairing link on GET", async () => {
    const app = express();
    app.use(express.json());
    app.use(shareGate);
    app.use("/host/pair", pairRouter);
    const server = await listen(app);
    try {
      const before = listDevices().length;
      const created = createPairing({ route: "lan" });
      const got = await request(server.port, "GET", `/host/pair/${created.token}`, {
        Host: "127.0.0.1",
        "User-Agent": "Mozilla iPhone Safari",
      });
      assert.equal(got.status, 200);
      assert.equal(got.headers["set-cookie"], undefined);
      assert.equal(listDevices().length, before);
      assert.match(got.body, /Sign in to OpenLeaf/);
      assert.equal(got.headers["cache-control"], "no-store");
      assert.equal(got.headers["x-robots-tag"], "noindex");

      const bare = await request(server.port, "POST", `/host/pair/${created.token}`, {
        Host: "127.0.0.1",
        "Content-Type": "application/x-www-form-urlencoded",
      });
      assert.notEqual(bare.status, 302);
      assert.equal(listDevices().length, before);

      const nonce = /name="nonce" value="([^"]+)"/.exec(got.body)?.[1] ?? "";
      assert.ok(nonce);
      const badOrigin = await request(
        server.port,
        "POST",
        `/host/pair/${created.token}`,
        {
          Host: "127.0.0.1",
          Origin: "https://evil.example",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        `nonce=${encodeURIComponent(nonce)}`,
      );
      assert.notEqual(badOrigin.status, 302);

      const posted = await request(
        server.port,
        "POST",
        `/host/pair/${created.token}`,
        {
          Host: `127.0.0.1:${server.port}`,
          Origin: `http://127.0.0.1:${server.port}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        `nonce=${encodeURIComponent(nonce)}`,
      );
      assert.equal(posted.status, 302);
      assert.ok(posted.headers["set-cookie"]);
      assert.equal(listDevices().length, before + 1);
    } finally {
      await server.close();
    }
  });

  it("sends an unpaired LAN visitor to host login", async () => {
    const app = express();
    app.use(express.json());
    app.use(shareGate);
    app.use("/api/guest", guestRouter);
    const server = await listen(app);
    try {
      const me = await request(server.port, "GET", "/api/guest/me", {
        Host: "127.0.0.1",
        "X-Forwarded-For": "10.9.8.7",
      });
      assert.equal(me.status, 200);
      const body = JSON.parse(me.body) as { mode: string };
      assert.equal(body.mode, "host-login");

      const owner = await request(server.port, "GET", "/api/guest/me", { Host: "127.0.0.1" });
      assert.equal(JSON.parse(owner.body).mode, "host");
    } finally {
      await server.close();
    }
  });
});
