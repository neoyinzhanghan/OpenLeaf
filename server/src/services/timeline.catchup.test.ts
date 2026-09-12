import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-catchup-"));
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;

const { loadConfig } = await import("../config.js");
loadConfig(true);

const { ensureProjectGit } = await import("./projectGit.js");
const {
  checkoutTimeline,
  getTimelineView,
  intentionalCommit,
  loadTimeline,
} = await import("./timeline.js");

async function git(id: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: path.join(projectsRoot, id),
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Agent",
      GIT_AUTHOR_EMAIL: "agent@local",
      GIT_COMMITTER_NAME: "Agent",
      GIT_COMMITTER_EMAIL: "agent@local",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return String(stdout);
}

async function seedProject(id: string): Promise<string> {
  const dir = path.join(projectsRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "main.tex"), "base\n", "utf8");
  await ensureProjectGit(id);
  const result = await intentionalCommit(id, { branchId: "main", message: "base" });
  return result.hash;
}

async function agentCommit(id: string, message: string, body: string): Promise<string> {
  const dir = path.join(projectsRoot, id);
  fs.writeFileSync(path.join(dir, "main.tex"), body, "utf8");
  await git(id, ["add", "-A"]);
  await git(id, ["commit", "-m", message, "--no-gpg-sign"]);
  return (await git(id, ["rev-parse", "HEAD"])).trim();
}

describe("timeline git catch-up", () => {
  after(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("appends external git commits onto the timeline on GET", async () => {
    const id = "catch-forward";
    const base = await seedProject(id);
    const first = await agentCommit(id, "agent one", "one\n");
    const second = await agentCommit(id, "agent two", "two\n");

    const view = await getTimelineView(id);
    const hashes = view.nodes.map((n) => n.gitHash);
    assert.ok(hashes.includes(base));
    assert.ok(hashes.includes(first));
    assert.ok(hashes.includes(second));
    assert.equal(view.headNode?.gitHash, second);

    const chain = view.nodes.filter((n) => n.branchId === "main");
    const byId = new Map(chain.map((n) => [n.id, n]));
    let cur = view.headNode;
    const walked: string[] = [];
    while (cur) {
      walked.push(cur.gitHash);
      cur = cur.parentId ? byId.get(cur.parentId) ?? null : null;
    }
    assert.deepEqual(walked, [second, first, base]);

    const again = await getTimelineView(id);
    assert.equal(again.nodes.length, view.nodes.length);
    assert.equal(again.headNode?.gitHash, second);
  });

  it("does not rewind or rewrite when git diverges", async () => {
    const id = "catch-diverge";
    await seedProject(id);
    const kept = await agentCommit(id, "kept", "kept\n");
    const view = await getTimelineView(id);
    assert.equal(view.headNode?.gitHash, kept);

    await git(id, ["reset", "--hard", "HEAD~1"]);
    const diverged = await agentCommit(id, "diverged", "other\n");

    const after = await getTimelineView(id);
    assert.equal(after.headNode?.gitHash, kept);
    assert.ok(!after.nodes.some((n) => n.gitHash === diverged));
  });

  it("keeps a historical checkout while the tip fast-forwards", async () => {
    const id = "catch-viewing";
    const base = await seedProject(id);
    const mid = await agentCommit(id, "mid", "mid\n");
    await getTimelineView(id);

    const tl = await loadTimeline(id);
    const baseNode = tl.nodes.find((n) => n.gitHash === base);
    assert.ok(baseNode);
    await checkoutTimeline(id, { nodeId: baseNode.id });

    const extra = await agentCommit(id, "while viewing", "later\n");
    const view = await getTimelineView(id);
    assert.equal(view.viewingGitHash, base);
    assert.equal(view.canEdit, false);
    assert.ok(view.nodes.some((n) => n.gitHash === extra));
    assert.equal(view.headNode?.gitHash, extra);
    assert.ok(view.nodes.some((n) => n.gitHash === mid));
  });
});
