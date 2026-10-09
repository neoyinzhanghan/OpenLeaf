import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCommandLine } from "./args.js";

describe("interactive menu parsing", () => {
  it("keeps flags typed after a command instead of dropping them", () => {
    const parsed = parseCommandLine("account reset-password --generate");
    assert.deepEqual(parsed.positionals, ["account", "reset-password"]);
    assert.equal(parsed.flags.get("generate"), true);
  });

  it("keeps a valued flag attached to the command", () => {
    const parsed = parseCommandLine("logs --lines 20");
    assert.deepEqual(parsed.positionals, ["logs"]);
    assert.equal(parsed.flags.get("lines"), "20");
  });
});
