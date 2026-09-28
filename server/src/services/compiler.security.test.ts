import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-compile-"));
const configDir = path.join(sandbox, "config");
const projects = path.join(sandbox, "projects");
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(projects, { recursive: true });
fs.copyFileSync(path.resolve(here, "../../../config/default.json"), path.join(configDir, "default.json"));
process.env.OPENLEAF_CONFIG_DIR = configDir;
process.env.OPENLEAF_PROJECTS_ROOT = projects;
process.env.OPENLEAF_HOST_GATEWAY = "0";

const { loadConfig } = await import("../config.js");
loadConfig(true);
const { compileProject } = await import("./compiler.js");

function writeProject(id: string, tex: string, extra?: Record<string, string>): void {
  const dir = path.join(projects, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "main.tex"), tex);
  fs.writeFileSync(
    path.join(dir, "openleaf.json"),
    `${JSON.stringify({ mainFile: "main.tex", engine: "pdflatex" })}\n`,
  );
  for (const [name, body] of Object.entries(extra ?? {})) {
    fs.writeFileSync(path.join(dir, name), body);
  }
}

describe("compile safety", () => {
  after(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("does not run a project latexmkrc", async () => {
    const marker = path.join(sandbox, "rc-marker");
    writeProject(
      "rc-case",
      "\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n",
      { latexmkrc: `system("touch ${marker}");\n` },
    );
    const result = await compileProject("rc-case");
    assert.equal(fs.existsSync(marker), false);
    assert.equal(result.ok, true);
    assert.equal(result.issues.some((issue) => issue.severity === "error"), false);
  });

  it("refuses to read a file outside the project", async () => {
    writeProject(
      "paranoid-case",
      "\\documentclass{article}\n\\begin{document}\n\\input{/etc/hostname}\n\\end{document}\n",
    );
    const result = await compileProject("paranoid-case");
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.severity === "error"));
    assert.match(result.log, /! /);
  });

  it("reports an undefined control sequence as a failed compile", async () => {
    writeProject(
      "error-case",
      "\\documentclass{article}\n\\begin{document}\n\\thisisnotamacro{oops}\n\\end{document}\n",
    );
    const result = await compileProject("error-case");
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.severity === "error" && /Undefined control sequence/.test(issue.message)));
  });
});
