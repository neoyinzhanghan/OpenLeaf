import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function commandOnPath(bin: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(bin, args, { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

const pdflatexInstalled = await commandOnPath("pdflatex", ["-version"]);
const latexmkInstalled = await commandOnPath("latexmk", ["-v"]);
const needsLatexmk = !pdflatexInstalled
  ? "pdflatex is not installed"
  : !latexmkInstalled
    ? "latexmk is not installed"
    : false;

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-uptodate-"));
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

function writeProject(id: string, tex: string): void {
  const dir = path.join(projects, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "main.tex"), tex);
  fs.writeFileSync(
    path.join(dir, "openleaf.json"),
    `${JSON.stringify({ mainFile: "main.tex", engine: "pdflatex" })}\n`,
  );
}

const article = "\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n";
const broken = "\\documentclass{article}\n\\begin{document}\n\\undefined\n\\end{document}\n";

describe("unchanged compile", () => {
  after(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("succeeds when latexmk has nothing to do", { skip: needsLatexmk }, async () => {
    writeProject("twice", article);
    const first = await compileProject("twice");
    assert.equal(first.ok, true, first.log.slice(-500));
    assert.ok(first.pdfRelative);
    const pdf = path.join(projects, "twice", first.pdfRelative);
    const aged = new Date(Date.now() - 10_000);
    fs.utimesSync(pdf, aged, aged);
    const second = await compileProject("twice");
    assert.equal(second.ok, true, second.log.slice(-500));
    assert.equal(second.upToDate, true);
    assert.equal(second.pdfUpdated, false);
  });

  it("stays an error when a previous failed build is unchanged", { skip: needsLatexmk }, async () => {
    writeProject("stale-error", broken);
    const first = await compileProject("stale-error");
    assert.equal(first.ok, false);
    if (first.pdfRelative) {
      const pdf = path.join(projects, "stale-error", first.pdfRelative);
      const aged = new Date(Date.now() - 10_000);
      fs.utimesSync(pdf, aged, aged);
    }
    const second = await compileProject("stale-error");
    assert.equal(second.ok, false, second.log.slice(-500));
  });
});
