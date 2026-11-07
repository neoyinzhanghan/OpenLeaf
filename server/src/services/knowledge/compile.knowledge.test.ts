/**
 * Fresh knowledge compile must succeed with \times, \frac, and a \kn to an
 * item that has never been compiled (overnight truth bug #5).
 */
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
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-kn-compile-"));
const configDir = path.join(sandbox, "config");
const projects = path.join(sandbox, "projects");
const library = path.join(sandbox, "library");
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(projects, { recursive: true });
fs.mkdirSync(path.join(library, "papers"), { recursive: true });
fs.copyFileSync(path.resolve(here, "../../../../config/default.json"), path.join(configDir, "default.json"));
process.env.OPENLEAF_CONFIG_DIR = configDir;
process.env.OPENLEAF_PROJECTS_ROOT = projects;
process.env.OPENLEAF_LIBRARY_ROOT = library;
process.env.OPENLEAF_HOST_GATEWAY = "0";

const { loadConfig } = await import("../../config.js");
loadConfig(true);
const { compileProject } = await import("../compiler.js");
const { createFact, updateFact } = await import("../library/facts.js");
const { addPaper } = await import("../library/index.js");
const { createKnowledgeItem } = await import("./items.js");
const { writeFile } = await import("../projectFs.js");

describe("knowledge first compile", () => {
  after(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it(
    "compiles a fresh item with \\times, \\frac, and \\kn on the first try",
    { skip: needsLatexmk },
    async () => {
      const paper = await addPaper({
        title: "DEMO compile fee",
        source: "web",
        url: "https://example.invalid/compile-fee",
      });
      const dir = path.join(library, "papers", paper.citekey);
      fs.mkdirSync(dir, { recursive: true });
      const text = "The DEMO fee is 100 USD.";
      fs.writeFileSync(path.join(dir, "snapshot.txt"), text);
      fs.writeFileSync(
        path.join(dir, "snapshot.json"),
        JSON.stringify({
          url: "https://example.invalid/compile-fee",
          fetchedAt: new Date().toISOString(),
          sha256: "demo",
          title: "DEMO compile fee",
          bytes: text.length,
          provenance: "pasted",
        }),
      );
      const fee = await createFact(paper.citekey, {
        type: "value",
        input: "DEMO compile fee",
        answer: "100",
        key: "demo-compile-fee",
        value: 100,
        unit: "USD",
        sourceKind: "web",
        highlights: [{ page: 1, start: 0, end: text.length, quote: text }],
      });
      await updateFact(paper.citekey, fee.id, { status: "confirmed", confirmWithContent: true });

      const base = await createKnowledgeItem({
        title: "DEMO compile base",
        knowledgeId: "demo-compile-base",
      });
      await writeFile(
        base.project.id,
        "main.tex",
        `\\documentclass{article}
\\usepackage{openleaf-knowledge}
\\begin{document}
\\begin{knowledge}[result=half]{DEMO compile base}
\\begin{calculation}{half}
\\frac{\\fact{demo-compile-fee}}{2}
\\end{calculation}
\\conclusion{Half is \\out{half}.}
\\end{knowledge}
\\end{document}
`,
      );

      const top = await createKnowledgeItem({
        title: "DEMO compile top",
        knowledgeId: "demo-compile-top",
      });
      await writeFile(
        top.project.id,
        "main.tex",
        `\\documentclass{article}
\\usepackage{openleaf-knowledge}
\\begin{document}
\\begin{knowledge}[result=total]{DEMO compile top}
\\begin{calculation}{total}
\\kn{demo-compile-base} \\times 3
\\end{calculation}
\\conclusion{Total is \\out{total}.}
\\end{knowledge}
\\end{document}
`,
      );

      // First compile of the never-compiled base, then the depender that uses \times and \kn.
      const baseResult = await compileProject(base.project.id);
      assert.equal(baseResult.ok, true, `base failed:\n${baseResult.log}`);
      assert.equal(baseResult.issues.some((i) => i.severity === "error"), false);

      const topResult = await compileProject(top.project.id);
      assert.equal(topResult.ok, true, `top failed:\n${topResult.log}`);
      assert.equal(topResult.issues.some((i) => i.severity === "error"), false);
      assert.doesNotMatch(topResult.log, /Missing \$ inserted/);
    },
  );
});
