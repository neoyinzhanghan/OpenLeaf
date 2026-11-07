import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { libraryAiOrigin } from "./libraryAiShare.js";

describe("library AI public origin", () => {
  it("uses an active https tunnel and otherwise stays on this machine", () => {
    assert.equal(
      libraryAiOrigin(
        { status: "active", url: "https://focus-value-mysql-develops.trycloudflare.com/" },
        8787,
      ),
      "https://focus-value-mysql-develops.trycloudflare.com",
    );
    assert.equal(libraryAiOrigin({ status: "stopped", url: "https://old.trycloudflare.com" }, 8787), "http://127.0.0.1:8787");
    assert.equal(libraryAiOrigin(null, 8787), "http://127.0.0.1:8787");
  });
});
