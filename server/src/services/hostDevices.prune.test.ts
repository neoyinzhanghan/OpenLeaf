import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-devices-"));
const previous = process.env.OPENLEAF_HOST_AUTH_DIR;

describe("revoked device retention", () => {
  before(() => {
    process.env.OPENLEAF_HOST_AUTH_DIR = dir;
    const day = 24 * 3600_000;
    const now = Date.now();
    const devices = [
      {
        id: "stale",
        label: "Old phone",
        userAgent: "test",
        route: "lan",
        createdAt: now - 200 * day,
        lastSeenAt: now - 200 * day,
        lastIp: "10.0.0.8",
        revokedAt: now - 100 * day,
      },
      {
        id: "recent",
        label: "Recent phone",
        userAgent: "test",
        route: "lan",
        createdAt: now - 2 * day,
        lastSeenAt: now - day,
        lastIp: "10.0.0.9",
        revokedAt: now - day,
      },
    ];
    fs.writeFileSync(path.join(dir, "host-devices.json"), `${JSON.stringify({ devices }, null, 2)}\n`);
  });

  after(() => {
    if (previous === undefined) delete process.env.OPENLEAF_HOST_AUTH_DIR;
    else process.env.OPENLEAF_HOST_AUTH_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("drops revoked devices older than 90 days and keeps a recent revocation", async () => {
    const { listDevices } = await import("./hostDevices.js");
    const ids = listDevices().map((device) => device.id);
    assert.equal(ids.includes("stale"), false);
    assert.equal(ids.includes("recent"), true);
  });
});
