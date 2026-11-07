import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { formatAbsolutePath, isWsl, pathSyntaxFor, toWindowsUnc } from "./hostPath.js";

describe("pathSyntaxFor", () => {
  const wsl = { platform: "linux" as const, wsl: true };
  const linux = { platform: "linux" as const, wsl: false };
  const mac = { platform: "darwin" as const, wsl: false };
  const win = { platform: "win32" as const, wsl: false };

  it("uses Windows syntax for a Windows browser on WSL or Windows", () => {
    assert.equal(pathSyntaxFor("windows", wsl), "windows");
    assert.equal(pathSyntaxFor("windows", win), "windows");
    assert.equal(pathSyntaxFor("windows", linux), "posix");
    assert.equal(pathSyntaxFor("windows", mac), "posix");
  });

  it("uses POSIX syntax for a Mac or Linux browser", () => {
    assert.equal(pathSyntaxFor("mac", wsl), "posix");
    assert.equal(pathSyntaxFor("linux", wsl), "posix");
    assert.equal(pathSyntaxFor("mac", mac), "posix");
    assert.equal(pathSyntaxFor("linux", linux), "posix");
  });

  it("uses the host computer's syntax when the browser is a phone", () => {
    assert.equal(pathSyntaxFor("other", wsl), "windows");
    assert.equal(pathSyntaxFor("other", win), "windows");
    assert.equal(pathSyntaxFor("other", mac), "posix");
    assert.equal(pathSyntaxFor("other", linux), "posix");
  });
});

describe("toWindowsUnc", () => {
  it("joins a WSL prefix with a POSIX path", () => {
    assert.equal(
      toWindowsUnc("\\\\wsl.localhost\\Ubuntu", "/home/yinzh/Projects/OpenLeaf/main.tex"),
      "\\\\wsl.localhost\\Ubuntu\\home\\yinzh\\Projects\\OpenLeaf\\main.tex",
    );
    assert.equal(toWindowsUnc("\\\\wsl.localhost\\Ubuntu\\", "/"), "\\\\wsl.localhost\\Ubuntu\\");
  });
});

describe("formatAbsolutePath", () => {
  const sample = "/home/yinzh/Projects/OpenLeaf";

  it("matches wslpath for a Windows viewer and stays POSIX for Mac and Linux", async () => {
    if (!isWsl()) return;
    const windows = execFileSync("wslpath", ["-w", sample], { encoding: "utf8" }).trim();
    assert.equal(await formatAbsolutePath(sample, "windows"), windows);
    assert.equal(await formatAbsolutePath(sample, "mac"), sample);
    assert.equal(await formatAbsolutePath(sample, "linux"), sample);
    assert.equal(await formatAbsolutePath(sample, "other"), windows);
  });
});
