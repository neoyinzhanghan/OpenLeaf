import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

const execFileAsync = promisify(execFile);

const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-track-changes-"));
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;

const { loadConfig } = await import("../config.js");
loadConfig(true);

const { ensureProjectGit } = await import("./projectGit.js");
const {
  annotateReplacedTables,
  expandChangedMetricsMacros,
  flattenTexFile,
  generateTrackChanges,
  hasLatexdiff,
  parseNoArgNewcommands,
  setLatexdiffAvailableForTests,
} = await import("./trackChanges.js");
const { ensureSnapshotRoot, snapshotRootIfPresent } = await import("./timeline.js");
const { diffTabular, findTableUnits, matchTableUnits, prepareTableBlocks, unwrapHeadingTargets } = await import(
  "./trackChangesTables.js"
);

const latexdiffInstalled = await hasLatexdiff();

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return String(stdout).trim();
}

function write(dir: string, rel: string, content: string): void {
  const dest = path.join(dir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, "utf8");
}

function listSource(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (rel: string) => {
    const abs = rel ? path.join(dir, rel) : dir;
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (ent.name === ".git" || ent.name === ".openleaf") continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(r);
      else out.set(r, fs.readFileSync(path.join(dir, r)));
    }
  };
  walk("");
  return out;
}

function assertMapsEqual(a: Map<string, Buffer>, b: Map<string, Buffer>, label: string): void {
  assert.equal(a.size, b.size, `${label} file count`);
  for (const [k, v] of a) {
    const other = b.get(k);
    assert.ok(other, `${label} missing ${k}`);
    assert.ok(v.equals(other!), `${label} changed ${k}`);
  }
}

async function twoCommitProject(
  id: string,
  oldFiles: Record<string, string>,
  newFiles: Record<string, string>,
): Promise<{ dir: string; oldHash: string; newHash: string }> {
  const dir = path.join(projectsRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(oldFiles)) write(dir, rel, content);
  if (!oldFiles["openleaf.json"]) {
    write(dir, "openleaf.json", JSON.stringify({ mainFile: "main.tex", engine: "pdflatex" }));
  }
  await ensureProjectGit(id);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "old", "--no-gpg-sign"]);
  const oldHash = await git(dir, ["rev-parse", "HEAD"]);
  for (const [rel, content] of Object.entries(newFiles)) write(dir, rel, content);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "new", "--no-gpg-sign"]);
  const newHash = await git(dir, ["rev-parse", "HEAD"]);
  return { dir, oldHash, newHash };
}

const ARTICLE_OLD = `\\documentclass{article}
\\begin{document}
The cat sat.
\\end{document}
`;
const ARTICLE_NEW = `\\documentclass{article}
\\begin{document}
The cat sat on the mat.
\\end{document}
`;

describe("flattenTexFile / metrics expand", () => {
  it("inlines \\input and leaves misc/ alone", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ol-flat-"));
    write(root, "main.tex", "\\input{metrics}\n\\input{sections/body}\n\\input{misc/notes}\n");
    write(root, "metrics.tex", "\\newcommand{\\Score}{1}\n");
    write(root, "sections/body.tex", "Hello body.\n");
    write(root, "misc/notes.tex", "secret draft\n");
    const flat = flattenTexFile(root, path.join(root, "main.tex"));
    assert.match(flat, /\\newcommand\{\\Score\}\{1\}/);
    assert.match(flat, /Hello body\./);
    assert.match(flat, /\\input\{misc\/notes\}/);
    assert.doesNotMatch(flat, /secret draft/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("parses no-arg newcommands and expands changed metrics in the body", () => {
    const cmds = parseNoArgNewcommands("\\newcommand{\\Score}{0.91}\\newcommand{\\N}[1]{x}");
    assert.equal(cmds.get("Score"), "0.91");
    assert.equal(cmds.has("N"), false);

    const oldTex =
      "\\newcommand{\\Score}{0.91}\\newcommand{\\Keep}{ok}\\begin{document}AUC was \\Score{}.\\end{document}";
    const newTex =
      "\\newcommand{\\Score}{0.93}\\newcommand{\\Keep}{ok}\\begin{document}AUC was \\Score{}.\\end{document}";
    const r = expandChangedMetricsMacros(oldTex, newTex);
    assert.deepEqual(r.expanded, ["Score"]);
    assert.match(r.old, /AUC was \{0\.91\}\./);
    assert.match(r.new, /AUC was \{0\.93\}\./);
    assert.match(r.old, /\\newcommand\{\\Score\}\{0\.91\}/);
    assert.match(r.new, /\\newcommand\{\\Score\}\{0\.93\}/);
  });

  it("adds a Table changed note on atomic tabular replacements", () => {
    const raw = `\\begin{document}
\\DIFdelbegin %DIFDELCMD < \\begin{tabular}{ll}
%DIFDELCMD < a & 1 \\\\
%DIFDELCMD < \\end{tabular}
%DIFDELCMD <  %%%
\\DIFdelend \\DIFaddbegin \\begin{tabular}{ll}
a & 2 \\\\
\\end{tabular}
 \\DIFaddend
\\end{document}
`;
    const r = annotateReplacedTables(raw);
    assert.equal(r.tables.changed, 1);
    assert.equal(r.tables.removed, 0);
    assert.match(r.tex, /\\OpenLeafTableChanged/);
    assert.match(r.tex, /Table changed/);
    assert.doesNotMatch(r.tex, /\\OpenLeafTableRemoved/);
  });

  it("adds a Table removed note when a tabular is deleted with no replacement", () => {
    const raw = `\\begin{document}
\\DIFdelbegin %DIFDELCMD < \\begin{tabular}{ll}
%DIFDELCMD < gone \\\\
%DIFDELCMD < \\end{tabular}
\\DIFdelend
more prose
\\end{document}
`;
    const r = annotateReplacedTables(raw);
    assert.equal(r.tables.changed, 0);
    assert.equal(r.tables.removed, 1);
    assert.match(r.tex, /\\OpenLeafTableRemoved/);
    assert.match(r.tex, /Table removed/);
  });
});

describe("heading and table markup helpers", () => {
  it("unwraps pandoc hypertarget heading wrappers so latexdiff sees the heading", () => {
    const tex = `\\begin{document}
\\hypertarget{methods}{%
\\section{Methods}\\label{methods}}

\\hypertarget{anchor}{Not a heading}
\\end{document}`;
    const out = unwrapHeadingTargets(tex);
    assert.match(out, /^\\section\{Methods\}\\label\{methods\}$/m);
    assert.doesNotMatch(out, /hypertarget\{methods\}/);
    assert.match(out, /\\hypertarget\{anchor\}\{Not a heading\}/);
  });

  it("marks only the changed cells of a tabular", () => {
    const oldTab = `\\begin{tabular}{lrr}
\\toprule
Name & A & B \\\\
\\midrule
WSIs & 3711 & 10 \\\\
Kept & 1 & 2 \\\\
Gone & 5 & 6 \\\\
\\bottomrule
\\end{tabular}`;
    const newTab = `\\begin{tabular}{lrr}
\\toprule
Name & A & B \\\\
\\midrule
WSIs & 3712 & 10 \\\\
Kept & 1 & 2 \\\\
Fresh & 7 & 8 \\\\
\\bottomrule
\\end{tabular}`;
    const out = diffTabular(oldTab, newTab);
    assert.ok(out);
    assert.match(out, /WSIs & \s*\\DIFdel\{3711\} \\DIFadd\{3712\}\s*& 10/);
    assert.match(out, /^Kept & 1 & 2 \\\\$/m);
    assert.match(out, /\\DIFdel\{Gone\}/);
    assert.match(out, /\\DIFadd\{Fresh\}/);
    assert.match(out, /\\toprule[\s\S]*\\midrule[\s\S]*\\bottomrule/);
    assert.equal((out.match(/\\midrule/g) ?? []).length, 1);
  });

  it("keeps \\multicolumn structure and uses color-only markup for \\shortstack", () => {
    const oldTab = "\\begin{tabular}{lrr}\n & \\multicolumn{2}{c}{\\textbf{External Test}} \\\\\n\\end{tabular}";
    const newTab =
      "\\begin{tabular}{lrr}\n & \\multicolumn{2}{c}{\\textbf{\\shortstack{Externally\\\\prepared}}} \\\\\n\\end{tabular}";
    const out = diffTabular(oldTab, newTab);
    assert.ok(out);
    assert.match(out, /\\multicolumn\{2\}\{c\}\{\\DIFdel\{\\textbf\{External Test\}\} \\OpenLeafCellAdd\{\\textbf\{\\shortstack/);
  });

  it("returns null when the column count changes", () => {
    assert.equal(
      diffTabular("\\begin{tabular}{ll}\na & b \\\\\n\\end{tabular}", "\\begin{tabular}{lll}\na & b & c \\\\\n\\end{tabular}"),
      null,
    );
  });

  it("pairs a moved table by label and widens the unit to its caption wrapper", () => {
    const table = (cell: string) => `\\begin{center}
\\begin{minipage}{\\textwidth}
\\captionof{table}{Cohort summary.}
\\label{tab:cohort}
\\begin{tabular}{ll}
a & ${cell} \\\\
\\end{tabular}
\\end{minipage}
\\end{center}`;
    const oldTex = `\\begin{document}\nIntro.\n${table("1")}\nMethods.\n\\end{document}`;
    const newTex = `\\begin{document}\nIntro.\nMethods.\n${table("2")}\n\\end{document}`;
    const oldUnits = findTableUnits(oldTex);
    const newUnits = findTableUnits(newTex);
    assert.equal(oldUnits.length, 1);
    assert.match(oldUnits[0].text, /^\\begin\{center\}[\s\S]*\\end\{center\}$/);
    assert.equal(oldUnits[0].label, "tab:cohort");
    const pairs = matchTableUnits(oldUnits, newUnits);
    assert.equal(pairs[0].old, oldUnits[0]);

    const prepared = prepareTableBlocks(oldTex, newTex);
    assert.match(prepared.old, /Intro\.\n\\OpenLeafTableBlock\{1\}\nMethods\./);
    assert.match(prepared.new, /Methods\.\n\\OpenLeafTableBlock\{1\}\n/);
    assert.doesNotMatch(prepared.new, /tabular/);
  });
});

describe("generateTrackChanges", () => {
  after(() => {
    setLatexdiffAvailableForTests(null);
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("rejects unknown hash, same commit, and missing latexdiff", async () => {
    const { oldHash, newHash } = await twoCommitProject("tc-errors", { "main.tex": ARTICLE_OLD }, {
      "main.tex": ARTICLE_NEW,
    });

    await assert.rejects(
      () => generateTrackChanges("tc-errors", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", newHash),
      (e: unknown) => {
        assert.equal((e as { status?: number }).status, 404);
        return true;
      },
    );
    await assert.rejects(
      () => generateTrackChanges("tc-errors", oldHash, oldHash),
      (e: unknown) => {
        assert.equal((e as { status?: number }).status, 400);
        assert.match((e as Error).message, /same commit/i);
        return true;
      },
    );

    setLatexdiffAvailableForTests(false);
    await assert.rejects(
      () => generateTrackChanges("tc-errors", oldHash, newHash),
      (e: unknown) => {
        assert.equal((e as { status?: number }).status, 501);
        assert.match((e as Error).message, /latexdiff/i);
        return true;
      },
    );
    setLatexdiffAvailableForTests(null);
  });

  it("marks prose insert/delete/replace and does not touch live or snapshot source", { skip: !latexdiffInstalled }, async () => {
    const { dir, oldHash, newHash } = await twoCommitProject(
      "tc-prose",
      { "main.tex": ARTICLE_OLD },
      { "main.tex": ARTICLE_NEW },
    );

    const oldSnap = await ensureSnapshotRoot("tc-prose", oldHash);
    const newSnap = await ensureSnapshotRoot("tc-prose", newHash);
    const liveBefore = listSource(dir);
    const oldBefore = listSource(oldSnap);
    const newBefore = listSource(newSnap);

    const result = await generateTrackChanges("tc-prose", oldHash, newHash);
    assert.equal(result.ok, true, result.log.slice(-800));
    assert.equal(result.cached, false);
    assert.ok(result.pdfRelative);
    assert.ok(fs.existsSync(path.join(dir, result.scratchRelative, result.pdfRelative)));

    const marked = fs.readFileSync(path.join(dir, result.scratchRelative, "main.tex"), "utf8");
    assert.match(marked, /\\DIF(add|addbegin)/i);
    assert.match(marked, /mat/);

    assertMapsEqual(liveBefore, listSource(dir), "live worktree");
    assertMapsEqual(oldBefore, listSource(oldSnap), "old snapshot");
    assertMapsEqual(newBefore, listSource(newSnap), "new snapshot");
    assert.equal(snapshotRootIfPresent("tc-prose", oldHash), oldSnap);

    const again = await generateTrackChanges("tc-prose", oldHash, newHash);
    assert.equal(again.ok, true);
    assert.equal(again.cached, true);
  });

  it("flattens multi-file \\input so section edits are marked", { skip: !latexdiffInstalled }, async () => {
    const { dir, oldHash, newHash } = await twoCommitProject(
      "tc-input",
      {
        "main.tex": "\\documentclass{article}\\begin{document}\\input{sections/body}\\end{document}\n",
        "sections/body.tex": "Alpha paragraph.\n",
      },
      {
        "main.tex": "\\documentclass{article}\\begin{document}\\input{sections/body}\\end{document}\n",
        "sections/body.tex": "Alpha paragraph with extra words.\n",
      },
    );

    const result = await generateTrackChanges("tc-input", oldHash, newHash);
    assert.equal(result.ok, true, result.log.slice(-800));
    const marked = fs.readFileSync(path.join(dir, result.scratchRelative, "main.tex"), "utf8");
    assert.match(marked, /extra words/);
    assert.match(marked, /\\DIF(add|addbegin)/i);
  });

  it("shows metrics macro value changes in the body markup", { skip: !latexdiffInstalled }, async () => {
    const { dir, oldHash, newHash } = await twoCommitProject(
      "tc-metrics",
      {
        "main.tex":
          "\\documentclass{article}\\input{metrics}\\begin{document}AUC was \\Score{}.\\end{document}\n",
        "metrics.tex": "\\newcommand{\\Score}{0.91}\n",
      },
      {
        "main.tex":
          "\\documentclass{article}\\input{metrics}\\begin{document}AUC was \\Score{}.\\end{document}\n",
        "metrics.tex": "\\newcommand{\\Score}{0.93}\n",
      },
    );

    const result = await generateTrackChanges("tc-metrics", oldHash, newHash);
    assert.equal(result.ok, true, result.log.slice(-800));
    assert.ok(result.expandedMacros.includes("Score"));
    const marked = fs.readFileSync(path.join(dir, result.scratchRelative, "main.tex"), "utf8");
    assert.match(marked, /0\.91/);
    assert.match(marked, /0\.93/);
    assert.match(marked, /\\DIF(add|addbegin|del|delbegin)/i);
  });

  it("marks headings, moved tables, and changed cells", { skip: !latexdiffInstalled }, async () => {
    const table = (cell: string, caption: string) => `\\begin{table}[h]
\\caption{${caption}}
\\label{tab:counts}
\\begin{tabular}{lr}
\\hline
Slides & ${cell} \\\\
\\hline
\\end{tabular}
\\end{table}`;
    const oldTex = `\\documentclass{article}
\\usepackage{hyperref}
\\begin{document}
\\hypertarget{intro}{%
\\section{Introduction}\\label{intro}}
Some intro.
${table("3711", "Slide counts for the external cohort.")}
\\hypertarget{design}{%
\\subsubsection{Study design}\\label{design}}
Design text.
\\end{document}
`;
    const newTex = `\\documentclass{article}
\\usepackage{hyperref}
\\begin{document}
\\hypertarget{intro}{%
\\section{Introduction}\\label{intro}}
Some intro.
\\hypertarget{design}{%
\\subsection{Study design and data}\\label{design}}
Design text.
${table("3712", "Slide counts for the externally prepared cohort.")}
\\end{document}
`;
    const { dir, oldHash, newHash } = await twoCommitProject(
      "tc-table-move",
      { "main.tex": oldTex },
      { "main.tex": newTex },
    );
    const result = await generateTrackChanges("tc-table-move", oldHash, newHash);
    assert.equal(result.ok, true, result.log.slice(-800));
    assert.equal(result.tableMarkup, "cells");
    const marked = fs.readFileSync(path.join(dir, result.scratchRelative, "main.tex"), "utf8");
    assert.match(marked, /\\DIFdel\{3711\} \\DIFadd\{3712\}/);
    assert.match(marked, /\\DIFadd(?:FL)?\{externally prepared/);
    assert.match(marked, /\\OpenLeafTableMoved/);
    assert.match(marked, /\\subsection\{[^}]*\\DIFadd\{/);
    assert.equal((marked.match(/^\\begin\{tabular\}/gm) ?? []).length, 1);
  });

  it("falls back to atomic tables when cell markup does not compile", { skip: !latexdiffInstalled }, async () => {
    const doc = (cell: string) =>
      `\\documentclass{article}\n\\begin{document}\n\\begin{tabular}{ll}\na & ${cell} \\\\\n\\end{tabular}\n\\end{document}\n`;
    const { dir, oldHash, newHash } = await twoCommitProject(
      "tc-table-fallback",
      { "main.tex": doc("plain") },
      { "main.tex": doc("\\verb|x_y|") },
    );
    const result = await generateTrackChanges("tc-table-fallback", oldHash, newHash);
    assert.equal(result.ok, true, result.log.slice(-800));
    assert.equal(result.tableMarkup, "atomic");
    const marked = fs.readFileSync(path.join(dir, result.scratchRelative, "main.tex"), "utf8");
    assert.match(marked, /Table changed/);
  });

  it("still compiles when a tabular cell changes", { skip: !latexdiffInstalled }, async () => {
    const oldTex = `\\documentclass{article}
\\usepackage{array}
\\begin{document}
\\begin{tabular}{ll}
a & 1 \\\\
\\end{tabular}
\\end{document}
`;
    const newTex = `\\documentclass{article}
\\usepackage{array}
\\begin{document}
\\begin{tabular}{ll}
a & 2 \\\\
\\end{tabular}
\\end{document}
`;
    const { dir, oldHash, newHash } = await twoCommitProject(
      "tc-table",
      { "main.tex": oldTex },
      { "main.tex": newTex },
    );
    const result = await generateTrackChanges("tc-table", oldHash, newHash);
    assert.equal(result.ok, true, result.log.slice(-800));
    assert.ok(result.pdfRelative);
    assert.equal(result.tableMarkup, "cells");
    const marked = fs.readFileSync(path.join(dir, result.scratchRelative, "main.tex"), "utf8");
    assert.match(marked, /a & \s*\\DIFdel\{1\} \\DIFadd\{2\}/);
    assert.doesNotMatch(marked, /\\OpenLeafTableMoved\n/);
  });
});
