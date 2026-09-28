import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-devices-"));
process.env.OPENLEAF_HOST_AUTH_DIR = dir;
fs.writeFileSync(
  path.join(dir, "host-auth.json"),
  JSON.stringify({
    username: "host",
    cookieSecret: Buffer.from("secret-key-32bytes-secret-key!!").toString("base64"),
  }),
);

const devices = await import("./hostDevices.js");

describe("host device sessions", () => {
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stores only a hash, and a link works once", () => {
    const created = devices.createPairing({ route: "lan", lanAddress: "192.168.1.5" });
    const first = devices.redeemPairing(created.token, { userAgent: "Mozilla iPhone Safari", ip: "192.168.1.23" });
    assert.ok(first);
    assert.equal(devices.redeemPairing(created.token, { userAgent: "iPhone", ip: "192.168.1.23" }), null);
    const stored = fs.readFileSync(path.join(dir, "host-devices.json"), "utf8");
    assert.equal(stored.includes(created.token), false);
    assert.match(stored, /iPhone/);
    assert.equal(devices.verifyDeviceToken("v1.aaaa.bbbb"), null);
    assert.ok(devices.verifyDeviceToken(first.sessionToken));
    assert.equal(devices.revokeDevice(first.device.id), true);
    assert.equal(devices.verifyDeviceToken(first.sessionToken), null);
  });

  it("rejects an expired link", () => {
    const created = devices.createPairing({ route: "tunnel" });
    devices.expirePairingForTests(created.id);
    assert.equal(
      devices.redeemPairing(created.token, { userAgent: "Android Chrome", ip: "10.0.0.8" }),
      null,
    );
    assert.equal(devices.getPairing(created.id)?.status, "expired");
  });

  it("rate-limits redeem attempts from one address", () => {
    const created = devices.createPairing({ route: "lan" });
    for (let i = 0; i < 20; i += 1) {
      devices.redeemPairing("wrong-token", { userAgent: "x", ip: "203.0.113.9" });
    }
    assert.equal(
      devices.redeemPairing(created.token, { userAgent: "x", ip: "203.0.113.9" }),
      null,
    );
  });
});
