import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import { hostHeaderAllowed, isLoopbackOwner, originAllowed } from "./requestGuard.js";

function req(over: {
  host?: string;
  origin?: string;
  method?: string;
  remoteAddress?: string;
  xff?: string;
}): IncomingMessage {
  return {
    headers: {
      host: over.host,
      origin: over.origin,
      "x-forwarded-for": over.xff,
    },
    method: over.method ?? "GET",
    socket: { remoteAddress: over.remoteAddress ?? "127.0.0.1" },
  } as IncomingMessage;
}

describe("host allowlist", () => {
  it("allows loopback names and rejects an unknown host", () => {
    assert.equal(hostHeaderAllowed(req({ host: "localhost:8787" })), true);
    assert.equal(hostHeaderAllowed(req({ host: "127.0.0.1:8787" })), true);
    assert.equal(hostHeaderAllowed(req({ host: "attacker.example" })), false);
  });

  it("allows a known tunnel hostname", () => {
    assert.equal(hostHeaderAllowed(req({ host: "demo.trycloudflare.com" })), true);
  });
});

describe("origin checks", () => {
  it("allows a same-origin state change and a loopback request with no Origin", () => {
    assert.equal(
      originAllowed(req({ host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787", method: "PUT" })),
      true,
    );
    assert.equal(originAllowed(req({ host: "127.0.0.1:8787", method: "PUT" })), true);
  });

  it("rejects a cross-origin write and a non-loopback write with no Origin", () => {
    assert.equal(
      originAllowed(
        req({
          host: "127.0.0.1:8787",
          origin: "https://evil.example",
          method: "PUT",
        }),
      ),
      false,
    );
    assert.equal(
      originAllowed(req({ host: "127.0.0.1:8787", method: "PUT", remoteAddress: "192.168.1.20" })),
      false,
    );
  });

  it("treats only a loopback socket plus a loopback Host as the owner", () => {
    assert.equal(isLoopbackOwner(req({ host: "127.0.0.1:8787" })), true);
    assert.equal(isLoopbackOwner(req({ host: "attacker.example" })), false);
    assert.equal(
      isLoopbackOwner(req({ host: "127.0.0.1:8787", remoteAddress: "192.168.1.20", xff: "127.0.0.1" })),
      false,
    );
  });
});
