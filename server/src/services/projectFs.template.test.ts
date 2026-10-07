import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-template-"));
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
const { createProject } = await import("./projectFs.js");

describe("createProject templates", () => {
  after(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("copies the shipped example and replaces template identities", async () => {
    const project = await createProject("from-example");
    const cfg = JSON.parse(fs.readFileSync(path.join(projects, project.id, "openleaf.json"), "utf8")) as {
      identities?: Array<{ id: string; name: string }>;
    };
    assert.equal(fs.existsSync(path.join(projects, "from-example", "main.tex")), true);
    assert.ok(cfg.identities && cfg.identities.length > 0);
    assert.notEqual(cfg.identities[0]?.id, "admin-neo");
    assert.notEqual(cfg.identities[0]?.name, "Admin Neo");
  });

  it("writes a short hello document when the template name does not exist", async () => {
    const project = await createProject("blank", "missing-template");
    const tex = fs.readFileSync(path.join(projects, project.id, "main.tex"), "utf8");
    assert.match(tex, /Hello from blank/);
  });
});
