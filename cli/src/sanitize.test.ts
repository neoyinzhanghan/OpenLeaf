import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactText } from "./sanitize.js";

describe("redactText", () => {
  it("redacts Unix paths under common mount points, not just the original allowlist", () => {
    // Regression: /mnt, /media, /srv, and macOS's /Volumes were missing from
    // the original (home|Users|tmp|var|opt|usr) allowlist, so a log line
    // referencing one of these leaked the full path (which can contain a
    // username or project name) into a support report.
    assert.equal(redactText("saved to /mnt/data/openleaf/library"), "saved to [path]");
    assert.equal(redactText("copied /media/usb/backup.zip"), "copied [path]");
    assert.equal(redactText("root at /srv/openleaf"), "root at [path]");
    assert.equal(redactText("external drive /Volumes/Backup/openleaf"), "external drive [path]");
    // Original allowlist entries still work.
    assert.equal(redactText("log at /home/neo/openleaf.log"), "log at [path]");
    assert.equal(redactText("log at /Users/neo/openleaf.log"), "log at [path]");
  });

  it("redacts Windows paths with forward slashes, not just backslashes", () => {
    // Regression: only backslash-separated Windows paths were redacted; a
    // path with forward slashes (e.g. normalized by another tool before
    // being logged) passed through untouched.
    assert.equal(redactText("saved to C:/Users/Ada/OpenLeaf/library"), "saved to [path]");
    assert.equal(redactText("saved to C:\\Users\\Ada\\OpenLeaf\\library"), "saved to [path]");
  });
});
