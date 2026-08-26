import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-hydrate-"));
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;

const { loadConfig } = await import("../../config.js");
loadConfig(true);
const { ProjectRoom } = await import("./room.js");

let seq = 0;

function makeProject(): { id: string; dir: string } {
  seq += 1;
  const id = `h${seq}`;
  const dir = path.join(projectsRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "main.tex"), "\\title{Test}\n", "utf8");
  return { id, dir };
}

async function openRoom(id: string): Promise<InstanceType<typeof ProjectRoom>> {
  const room = new ProjectRoom(id, seq);
  await room.whenReady();
  return room;
}

describe("ProjectRoom eager collab hydrate", () => {
  before(() => {
    loadConfig(true);
  });

  after(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("hydrates manuscript files but not data/ csvs or logs", async () => {
    const { id, dir } = makeProject();
    fs.writeFileSync(path.join(dir, "notes.md"), "# notes\n", "utf8");
    fs.mkdirSync(path.join(dir, "sections"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sections", "intro.tex"), "hello\n", "utf8");
    fs.mkdirSync(path.join(dir, "data"), { recursive: true });
    fs.writeFileSync(path.join(dir, "data", "table.csv"), "a,b\n1,2\n", "utf8");
    fs.writeFileSync(path.join(dir, "run.log"), "log line\n", "utf8");
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "scripts", "plot.py"), "print(1)\n", "utf8");

    const room = await openRoom(id);
    try {
      const keys = [...room.files.keys()].sort();
      assert.deepEqual(keys, ["main.tex", "notes.md", "sections/intro.tex"]);
      assert.equal(room.files.get("data/table.csv"), undefined);
      assert.equal(room.files.get("run.log"), undefined);
      assert.equal(room.files.get("scripts/plot.py"), undefined);
    } finally {
      await room.destroy();
    }
  });

  it("ensureFile still seeds a small non-eager text file when opened", async () => {
    const { id, dir } = makeProject();
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "scripts", "plot.py"), "print(1)\n", "utf8");

    const room = await openRoom(id);
    try {
      assert.equal(room.files.get("scripts/plot.py"), undefined);
      const text = await room.ensureFile("scripts/plot.py");
      assert.equal(text.toString(), "print(1)\n");
      assert.equal(room.files.get("scripts/plot.py")?.toString(), "print(1)\n");
    } finally {
      await room.destroy();
    }
  });

  it("rejects logs from ensureFile so they stay out of the CRDT", async () => {
    const { id, dir } = makeProject();
    fs.writeFileSync(path.join(dir, "run.log"), "log line\n", "utf8");

    const room = await openRoom(id);
    try {
      await assert.rejects(() => room.ensureFile("run.log"));
      assert.equal(room.files.get("run.log"), undefined);
    } finally {
      await room.destroy();
    }
  });
});
