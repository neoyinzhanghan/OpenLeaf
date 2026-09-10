import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-ai-"));
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;

const { loadConfig } = await import("../config.js");
loadConfig(true);

const { ensureProjectGit } = await import("./projectGit.js");
const { intentionalCommit, forkBranch, loadTimeline, getBranch, ensureBranchRoot } = await import("./timeline.js");
const { assertAiWritablePath, assertAiReadablePath, buildStarterPrompt } = await import("./aiShare.js");

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (e) {
    const ex = e as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof ex.code === "number" ? ex.code : 1,
      stdout: String(ex.stdout ?? ""),
      stderr: String(ex.stderr ?? ""),
    };
  }
}

async function seedProject(id: string): Promise<void> {
  const dir = path.join(projectsRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "main.tex"), "base\n", "utf8");
  fs.writeFileSync(
    path.join(dir, "openleaf.json"),
    JSON.stringify({ mainFile: "main.tex", engine: "pdflatex" }),
    "utf8",
  );
  await ensureProjectGit(id);
  await intentionalCommit(id, { branchId: "main", message: "base" });
}

describe("aiShare path guards", () => {
  it("rejects path traversal and runtime paths", () => {
    assert.throws(() => assertAiWritablePath("../x"), /Invalid path/i);
    assert.throws(() => assertAiWritablePath(".openleaf/x"), /runtime/i);
    assert.throws(() => assertAiWritablePath(".git/config"), /runtime/i);
    assert.throws(() => assertAiWritablePath("openleaf.json"), /openleaf\.json/i);
    assert.equal(assertAiWritablePath("src/main.tex"), "src/main.tex");
  });

  it("allows reading openleaf.json but not writing it", () => {
    assert.equal(assertAiReadablePath("openleaf.json"), "openleaf.json");
    assert.throws(() => assertAiWritablePath("openleaf.json"), /openleaf\.json/i);
  });

  it("builds a self-contained starter prompt with API auth", () => {
    const p = buildStarterPrompt(
      "https://example.test/ai/tok",
      {
        parentBranchName: "review-alice",
        branchName: "ai/claude-pass1-abc",
        token: "secret-token",
      },
      "https://example.test/api/ai/v1",
    );
    assert.match(p, /review-alice/);
    assert.match(p, /ai\/claude-pass1-abc/);
    assert.match(p, /Authorization: Bearer secret-token/);
    assert.match(p, /Do not browse/);
    assert.match(p, /apply_patch/);
  });
});

describe("AI fork + commit", () => {
  const id = "ai-fork-project";

  before(async () => {
    await seedProject(id);
  });

  after(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("eager fork with activate:false keeps main active", async () => {
    const beforeTl = await loadTimeline(id);
    const main = getBranch(beforeTl, "main");
    assert.ok(main.headNodeId);
    const forked = await forkBranch(id, {
      fromNodeId: main.headNodeId!,
      name: "ai/test-keep-main",
      activate: false,
    });
    const afterTl = await loadTimeline(id);
    assert.equal(afterTl.activeBranchId, "main");
    assert.equal(forked.branch.name, "ai/test-keep-main");
    assert.notEqual(afterTl.activeBranchId, forked.branch.id);
  });

  it("intentionalCommit updates named gitRef tip", async () => {
    const tl = await loadTimeline(id);
    const main = getBranch(tl, "main");
    const forked = await forkBranch(id, {
      fromNodeId: main.headNodeId!,
      name: "ai/test-commit-ref",
      activate: false,
    });
    const wt = await ensureBranchRoot(id, forked.branch.id);
    fs.writeFileSync(path.join(wt, "AI_TEST.txt"), "hi\n", "utf8");
    const result = await intentionalCommit(id, {
      branchId: forked.branch.id,
      message: "AI test commit",
      author: { name: "AI:test", email: "ai@openleaf.local" },
    });
    const tip = await git(path.join(projectsRoot, id), ["rev-parse", `refs/heads/${forked.branch.gitRef}`]);
    assert.equal(tip.code, 0, tip.stderr);
    assert.equal(tip.stdout.trim(), result.hash);
  });
});
