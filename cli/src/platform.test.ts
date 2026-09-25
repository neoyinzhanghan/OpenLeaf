import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  browserLauncher,
  commandLineHasInstance,
  commandLineProbe,
  npmBuildCommand,
  terminateCommand,
  toolLookup,
} from "./platform.js";

describe("platform commands", () => {
  it("recognizes the instance marker inside quoted Windows and macOS command lines", () => {
    const id = "abc123def456";
    const windows = `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Ada\\OpenLeaf\\server\\dist\\index.js" --openleaf-instance=${id}`;
    const mac = `/usr/local/bin/node /Users/Ada/OpenLeaf/server/dist/index.js --openleaf-instance=${id}`;
    assert.equal(commandLineHasInstance(windows, id), true);
    assert.equal(commandLineHasInstance(mac, id), true);
    assert.equal(commandLineHasInstance(windows, "other"), false);
    assert.equal(commandLineHasInstance("", id), false);
    assert.equal(commandLineHasInstance(null, id), false);
  });

  it("asks macOS ps for the full command line", () => {
    const probe = commandLineProbe(42, "darwin");
    assert.deepEqual(probe, { file: "/bin/ps", args: ["-ww", "-p", "42", "-o", "command="] });
  });

  it("reads Windows command lines with Windows PowerShell, not a profile", () => {
    const probe = commandLineProbe(42, "win32");
    assert.ok(probe);
    assert.match(probe.file.replaceAll("\\", "/"), /WindowsPowerShell\/v1\.0\/powershell\.exe$/);
    assert.ok(probe.args.includes("-NonInteractive"));
    assert.ok(probe.args.includes("-NoProfile"));
    assert.match(probe.args.join(" "), /Get-CimInstance Win32_Process/);
    assert.match(probe.args.join(" "), /ProcessId=42/);
    assert.equal(commandLineProbe(-1, "win32"), null);
  });

  it("opens the browser with open on macOS and Start-Process in PowerShell", () => {
    const url = "http://127.0.0.1:8787";
    assert.deepEqual(browserLauncher(url, "darwin"), { file: "/usr/bin/open", args: [url] });
    const windows = browserLauncher(url, "win32");
    assert.ok(windows);
    assert.match(windows.file, /powershell\.exe$/);
    assert.match(windows.args.join(" "), /Start-Process/);
    assert.match(windows.args.join(" "), /127\.0\.0\.1:8787/);
    assert.equal(browserLauncher("file:///etc/passwd", "win32"), null);
  });

  it("runs npm through cmd on Windows and directly elsewhere", () => {
    assert.deepEqual(npmBuildCommand("win32"), { command: "npm", args: ["run", "build"], shell: true });
    assert.equal(npmBuildCommand("darwin").shell, false);
    assert.equal(npmBuildCommand("linux").shell, false);
  });

  it("stops a verified Windows process with taskkill and a Unix process group", () => {
    const win = terminateCommand(99, true, "win32");
    assert.ok("file" in win);
    assert.match(win.file, /taskkill\.exe$/);
    assert.deepEqual(win.args, ["/PID", "99", "/T", "/F"]);
    assert.deepEqual(terminateCommand(99, false, "darwin"), { signal: "SIGTERM", group: true });
    assert.deepEqual(terminateCommand(99, true, "linux"), { signal: "SIGKILL", group: true });
  });

  it("looks up tools with where.exe on Windows and which on macOS", () => {
    assert.match(toolLookup("pdflatex", "win32").file, /where\.exe$/);
    assert.deepEqual(toolLookup("pdflatex", "darwin"), { file: "/usr/bin/which", args: ["pdflatex"] });
  });
});
