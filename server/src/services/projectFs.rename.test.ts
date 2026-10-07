import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-rename-"));
const configDir = path.join(sandbox, "config");
const projects = path.join(sandbox, "projects");
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(projects, { recursive: true });
fs.copyFileSync(path.join(repo, "config/default.json"), path.join(configDir, "default.json"));
process.env.OPENLEAF_CONFIG_DIR = configDir;
process.env.OPENLEAF_PROJECTS_ROOT = projects;
process.env.OPENLEAF_LIBRARY_ROOT = path.join(sandbox, "library");
process.env.OPENLEAF_REPO_ROOT = repo;
process.env.OPENLEAF_HOST_GATEWAY = "0";

const { loadConfig } = await import("../config.js");
loadConfig(true);
const { createProject, getProject, projectMetaForCaller, renameProject } = await import("./projectFs.js");

describe("renameProject", () => {
  after(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("moves the folder, keeps the files, and rewrites git worktree paths", async () => {
    const created = await createProject("old-name", "missing-template");
    const src = created.path;
    const wt = path.join(src, ".openleaf", "worktrees", "leaf");
    fs.mkdirSync(wt, { recursive: true });
    const gitWt = path.join(src, ".git", "worktrees", "leaf");
    fs.mkdirSync(gitWt, { recursive: true });
    const link = path.join(wt, ".git");
    fs.writeFileSync(link, `gitdir: ${path.join(src, ".git", "worktrees", "leaf")}\n`);
    fs.writeFileSync(path.join(gitWt, "gitdir"), `${link}\n`);

    const next = await renameProject("old-name", "new-name");
    assert.equal(next.id, "new-name");
    assert.equal(next.path, path.join(projects, "new-name"));
    assert.equal(fs.existsSync(src), false);
    assert.match(fs.readFileSync(path.join(next.path, "main.tex"), "utf8"), /Hello from old-name/);
    const movedLink = path.join(next.path, ".openleaf", "worktrees", "leaf", ".git");
    assert.match(fs.readFileSync(movedLink, "utf8"), new RegExp(path.join(next.path, ".git", "worktrees", "leaf")));
    assert.equal(
      fs.readFileSync(path.join(next.path, ".git", "worktrees", "leaf", "gitdir"), "utf8").trim(),
      movedLink,
    );
    assert.equal((await getProject("new-name")).path, next.path);
  });

  it("refuses to replace an existing project folder", async () => {
    await createProject("taken", "missing-template");
    await createProject("other", "missing-template");
    await assert.rejects(renameProject("other", "taken"), /already exists/);
    assert.equal(fs.existsSync(path.join(projects, "other")), true);
  });

  it("keeps spaces in the title and uses filenamify for the folder", async () => {
    await createProject("slash-src", "missing-template");
    const next = await renameProject("slash-src", "Notes: draft");
    assert.equal(next.name, "Notes: draft");
    assert.equal(next.id, "Notes- draft");
    assert.equal(fs.existsSync(path.join(projects, "slash-src")), false);
    assert.match(fs.readFileSync(path.join(next.path, "openleaf.json"), "utf8"), /Notes: draft/);
  });

  it("leaves the folder in place when the title did not change", async () => {
    const before = await getProject("new-name");
    const again = await renameProject("new-name", "new-name");
    assert.equal(again.path, before.path);
    assert.equal(again.id, before.id);
    assert.equal(fs.existsSync(before.path), true);
  });

  it("hides the folder path from a guest", async () => {
    const meta = await getProject("new-name");
    assert.equal(projectMetaForCaller(meta, "host").path, meta.path);
    assert.equal(projectMetaForCaller(meta, "guest").path, "");
  });
});
