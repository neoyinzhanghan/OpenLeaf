import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { forwardSignalsToChild } from "./setup.js";

describe("setup build child", () => {
  it("forwards SIGTERM to the build child and then drops the listener", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: "ignore",
    });
    const stop = forwardSignalsToChild(child);
    try {
      const exited = new Promise<NodeJS.Signals | number | null>((resolve) => {
        child.once("exit", (code, signal) => resolve(signal ?? code));
      });
      process.kill(process.pid, "SIGTERM");
      const how = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("build child was still running")), 3000);
        }),
      ]);
      assert.equal(how, "SIGTERM");
    } finally {
      stop();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});
