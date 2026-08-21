import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-git-"));
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;

const { loadConfig } = await import("../config.js");
loadConfig(true);
const { autoCommitProject } = await import("./projectGit.js");

async function git(id: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: path.join(projectsRoot, id) });
  return String(stdout);
}

function makeProject(id: string): void {
  const dir = path.join(projectsRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "main.tex"), "hello\n", "utf8");
}

describe("autoCommitProject path-scoped comments", () => {
  before(() => {
    loadConfig(true);
  });

  after(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("commits only comments.json when paths are given", async () => {
    const id = "comment-only";
    makeProject(id);

    const initial = await autoCommitProject(id, { message: "Initial project snapshot" });
    assert.equal(initial.committed, true);

    fs.writeFileSync(path.join(projectsRoot, id, "main.tex"), "hello\nedited\n", "utf8");
    fs.writeFileSync(path.join(projectsRoot, id, "notes.md"), "untracked notes\n", "utf8");
    fs.writeFileSync(
      path.join(projectsRoot, id, "comments.json"),
      `${JSON.stringify({ version: 1, threads: [{ id: "t1" }] }, null, 2)}\n`,
      "utf8",
    );

    const result = await autoCommitProject(id, {
      message: "Comment on main.tex:1",
      paths: ["comments.json"],
    });
    assert.equal(result.committed, true);

    const files = (await git(id, ["show", "--name-only", "--pretty=format:", "HEAD"]))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    assert.deepEqual(files, ["comments.json"]);

    const status = await git(id, ["status", "--porcelain"]);
    assert.match(status, /main\.tex/);
    assert.match(status, /notes\.md/);
    assert.doesNotMatch(status, /comments\.json/);
  });

  it("still snapshots the whole tree when paths are omitted", async () => {
    const id = "full-tree";
    makeProject(id);
    const initial = await autoCommitProject(id, { message: "Initial project snapshot" });
    assert.equal(initial.committed, true);

    fs.writeFileSync(path.join(projectsRoot, id, "main.tex"), "hello\nedited\n", "utf8");
    fs.writeFileSync(path.join(projectsRoot, id, "extra.tex"), "new file\n", "utf8");

    const result = await autoCommitProject(id, { message: "Save main.tex" });
    assert.equal(result.committed, true);

    const files = (await git(id, ["show", "--name-only", "--pretty=format:", "HEAD"]))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .sort();
    assert.deepEqual(files, ["extra.tex", "main.tex"]);
  });
});
