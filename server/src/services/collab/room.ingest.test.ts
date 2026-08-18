import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-collab-"));
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;

const { loadConfig } = await import("../../config.js");
loadConfig(true);
const { ProjectRoom } = await import("./room.js");

let seq = 0;

function makeProject(initial: string): { id: string; file: string } {
  seq += 1;
  const id = `p${seq}`;
  const dir = path.join(projectsRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "main.tex");
  fs.writeFileSync(file, initial, "utf8");
  return { id, file };
}

async function openRoom(id: string): Promise<InstanceType<typeof ProjectRoom>> {
  const room = new ProjectRoom(id, seq);
  await room.whenReady();
  return room;
}

describe("ProjectRoom external-write ingest", () => {
  before(() => {
    loadConfig(true);
  });

  after(async () => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("keeps sequential external writes (does not revert after ingest+flush)", async () => {
    const base = "line0\n";
    const { id, file } = makeProject(base);
    const room = await openRoom(id);
    try {
      let content = base;
      for (let i = 1; i <= 8; i += 1) {
        content += `line${i}\n`;
        fs.writeFileSync(file, content, "utf8");
        await room.ingestDiskPaths(["main.tex"]);
      }
      await room.flushNow({ commit: false });
      assert.equal(fs.readFileSync(file, "utf8"), content);
      assert.equal(room.files.get("main.tex")?.toString(), content);
    } finally {
      await room.destroy();
    }
  });

  it("merges a non-overlapping external write into an editor-dirty buffer", async () => {
    const { id, file } = makeProject("A\nB\nC\n");
    const room = await openRoom(id);
    try {
      room.doc.transact(() => {
        const ytext = room.files.get("main.tex");
        assert.ok(ytext);
        ytext.delete(2, 1);
        ytext.insert(2, "X");
      }, "client");
      fs.writeFileSync(file, "A\nB\nY\n", "utf8");
      await room.ingestDiskPaths(["main.tex"]);
      await room.flushNow({ commit: false });
      assert.equal(fs.readFileSync(file, "utf8"), "A\nX\nY\n");
      assert.equal(room.files.get("main.tex")?.toString(), "A\nX\nY\n");
    } finally {
      await room.destroy();
    }
  });

  it("does not clobber an external write if flush runs before ingest", async () => {
    const { id, file } = makeProject("A\nB\nC\n");
    const room = await openRoom(id);
    try {
      room.doc.transact(() => {
        const ytext = room.files.get("main.tex");
        assert.ok(ytext);
        ytext.delete(2, 1);
        ytext.insert(2, "X");
      }, "client");
      fs.writeFileSync(file, "A\nB\nY\n", "utf8");
      await room.flushNow({ commit: false });
      assert.equal(fs.readFileSync(file, "utf8"), "A\nX\nY\n");
    } finally {
      await room.destroy();
    }
  });

  it("prefers disk when editor and external edits overlap", async () => {
    const { id, file } = makeProject("A\nB\nC\n");
    const room = await openRoom(id);
    try {
      room.doc.transact(() => {
        const ytext = room.files.get("main.tex");
        assert.ok(ytext);
        ytext.delete(2, 1);
        ytext.insert(2, "X");
      }, "client");
      fs.writeFileSync(file, "A\nY\nC\n", "utf8");
      await room.ingestDiskPaths(["main.tex"]);
      await room.flushNow({ commit: false });
      assert.equal(fs.readFileSync(file, "utf8"), "A\nY\nC\n");
    } finally {
      await room.destroy();
    }
  });
});
