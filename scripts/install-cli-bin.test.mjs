import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import {
  binCandidates,
  chooseBinDir,
  pathContains,
  pathExportSnippet,
  shellStartupFile,
  windowsShimBodies,
} from "./install-cli-bin.mjs";

describe("openleaf command install", () => {
  it("picks a PATH directory for Linux, macOS, and Windows", () => {
    const home = "/home/ada";
    const linux = binCandidates({
      env: { npm_config_prefix: "/usr" },
      platform: "linux",
      execPath: "/usr/bin/node",
      homedir: home,
      nvmVersions: null,
    });
    assert.ok(linux.includes("/usr/bin"));
    assert.ok(linux.includes(path.join(home, ".local", "bin")));
    assert.equal(
      chooseBinDir(linux, "/usr/local/sbin:/usr/bin", "linux", (dir) => dir !== "/usr/bin"),
      path.join(home, ".local", "bin"),
    );
    assert.equal(
      chooseBinDir(linux, "/usr/bin:/bin", "linux", () => true),
      "/usr/bin",
    );
    assert.equal(shellStartupFile("linux", "/bin/bash", home), path.join(home, ".bashrc"));
    assert.match(pathExportSnippet(path.join(home, ".local", "bin"), home, false), /\$HOME\/\.local\/bin/);

    const mac = binCandidates({
      env: {},
      platform: "darwin",
      execPath: "/usr/local/bin/node",
      homedir: "/Users/ada",
      nvmVersions: null,
    });
    assert.ok(mac.includes("/opt/homebrew/bin"));
    assert.ok(mac.includes("/usr/local/bin"));
    assert.equal(shellStartupFile("darwin", "/bin/zsh", "/Users/ada"), path.join("/Users/ada", ".zshrc"));
    assert.equal(
      chooseBinDir(mac, "/opt/homebrew/bin:/usr/bin", "darwin", () => true),
      "/opt/homebrew/bin",
    );

    const win = binCandidates({
      env: {
        APPDATA: "C:\\Users\\ada\\AppData\\Roaming",
        npm_config_prefix: "C:\\Users\\ada\\AppData\\Roaming\\npm",
      },
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      homedir: "C:\\Users\\ada",
      nvmVersions: null,
    });
    assert.equal(win[0], path.join("C:\\Users\\ada\\AppData\\Roaming", "npm"));
    assert.equal(
      shellStartupFile("win32", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "C:\\Users\\ada"),
      null,
    );
    const shims = windowsShimBodies(
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\src\\OpenLeaf\\cli\\bin\\openleaf.js",
    );
    assert.match(shims.cmd, /"C:\\Program Files\\nodejs\\node.exe"/);
    assert.match(shims.cmd, /%\*/);
    assert.match(shims.sh, /\/c\/Program Files\/nodejs\/node.exe/);
    assert.match(shims.sh, /\/c\/src\/OpenLeaf\/cli\/bin\/openleaf.js/);
    assert.equal(
      pathContains(
        "C:\\Users\\ada\\AppData\\Roaming\\npm;C:\\Windows",
        "c:\\users\\ada\\appdata\\roaming\\npm",
        "win32",
      ),
      true,
    );

    const skipped = binCandidates({
      env: { npm_config_prefix: "/home/ada/.cursor-server/prefix" },
      platform: "linux",
      execPath: "/home/ada/.cursor-server/bin/node",
      homedir: home,
      nvmVersions: "/home/ada/.nvm/versions/node/v22.0.0/bin",
    });
    assert.equal(
      skipped.some((dir) => dir.includes(".cursor-server")),
      false,
    );
    assert.ok(skipped.includes("/home/ada/.nvm/versions/node/v22.0.0/bin"));
  });
});
