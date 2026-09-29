/**
 * GET /host/pair/:token must not remember a nonce for a token that is not a
 * live pending pairing. This fails on 2a4356e, which stores every request.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import express from "express";

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-pair-nonce-"));
const configDir = path.join(sandbox, "config");
fs.mkdirSync(configDir, { recursive: true });
fs.copyFileSync(path.resolve(here, "../../../config/default.json"), path.join(configDir, "default.json"));
process.env.OPENLEAF_CONFIG_DIR = configDir;
process.env.OPENLEAF_HOST_AUTH_DIR = configDir;
process.env.OPENLEAF_PROJECTS_ROOT = path.join(sandbox, "projects");
process.env.OPENLEAF_HOST_GATEWAY = "0";

const { loadConfig } = await import("../config.js");
loadConfig(true);
const { pairRouter, pairNonceCount } = await import("./host.js");
const { createPairing } = await import("../services/hostDevices.js");

const app = express();
app.use("/host/pair", pairRouter);
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

after(() => {
  server.closeAllConnections();
  server.close();
});

describe("pairing nonces", () => {
  it("does not store a nonce for an unknown or expired token", async () => {
    const before = pairNonceCount();
    for (let i = 0; i < 20; i += 1) {
      const res = await fetch(`${base}/host/pair/not-a-token-${i}`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /expired or was already used/);
      assert.equal(html.includes('name="nonce"'), false);
    }
    assert.equal(pairNonceCount(), before);

    const pairing = createPairing({ route: "lan", lanAddress: "127.0.0.2" });
    const ok = await fetch(`${base}/host/pair/${pairing.token}`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /Sign in/);
    assert.equal(pairNonceCount(), before + 1);
  });
});
