import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-comments-"));
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;

const { loadConfig } = await import("../config.js");
loadConfig(true);

const { createProject } = await import("./projectFs.js");
const {
  addCommentReply,
  createComment,
  deleteComment,
  listComments,
  patchComment,
} = await import("./comments.js");

const authorA = { id: "admin-neo", name: "Admin Neo", color: "#0F766E" };
const authorAi = { id: "ai-deadbeef", name: "AI · helper", color: "#7C3AED" };

describe("comments threads", () => {
  const id = "comments-demo";

  before(async () => {
    await createProject(id);
  });

  after(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("creates a source-anchored thread with author attribution", async () => {
    const thread = await createComment(id, {
      author: authorA,
      body: "Tighten this sentence",
      anchor: { file: "main.tex", line: 12, quote: "hello world" },
    });
    assert.equal(thread.authorId, authorA.id);
    assert.equal(thread.authorName, authorA.name);
    assert.equal(thread.authorColor, authorA.color);
    assert.equal(thread.anchor.file, "main.tex");
    assert.equal(thread.resolved, false);
    assert.deepEqual(thread.replies, []);

    const list = await listComments(id);
    assert.ok(list.some((t) => t.id === thread.id));
  });

  it("supports threaded replies from another author (incl. AI)", async () => {
    const root = await createComment(id, {
      author: authorA,
      body: "Root note",
      anchor: { file: "main.tex", line: 20 },
    });
    const replied = await addCommentReply(id, root.id, {
      author: authorAi,
      body: "AI suggestion: rephrase the claim.",
    });
    assert.equal(replied.replies.length, 1);
    assert.equal(replied.replies[0]!.authorId, authorAi.id);
    assert.equal(replied.replies[0]!.authorName, authorAi.name);
    assert.equal(replied.replies[0]!.body, "AI suggestion: rephrase the claim.");
    assert.ok(replied.updatedAt >= root.updatedAt);
  });

  it("creates a PDF-anchored thread", async () => {
    const thread = await createComment(id, {
      author: authorA,
      body: "Figure caption looks off",
      anchor: { file: "main.tex", line: 88, pdfPage: 3, pdfX: 120, pdfY: 400 },
    });
    assert.equal(thread.anchor.pdfPage, 3);
    assert.equal(thread.anchor.pdfX, 120);
  });

  it("resolves and deletes threads", async () => {
    const thread = await createComment(id, {
      author: authorA,
      body: "Temporary",
      anchor: { file: "notes.md", line: 1 },
    });
    const resolved = await patchComment(id, thread.id, { resolved: true });
    assert.equal(resolved.resolved, true);
    await deleteComment(id, thread.id);
    const list = await listComments(id);
    assert.ok(!list.some((t) => t.id === thread.id));
  });
});
