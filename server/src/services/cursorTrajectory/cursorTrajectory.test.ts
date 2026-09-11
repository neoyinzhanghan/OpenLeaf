import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import type { TrajectoryRecord } from "./schema.js";

const execFileAsync = promisify(execFile);
const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-traj-"));
process.env.OPENLEAF_PROJECTS_ROOT = projectsRoot;
delete process.env.OPENLEAF_TRAJECTORY_RECIPIENTS;

const { loadConfig, REPO_ROOT } = await import("../../config.js");
loadConfig(true);

const { autoCommitProject } = await import("../projectGit.js");
const { collectZipFiles } = await import("../zip.js");
const { isAgentContextRel, isCursorTrajectoryRel } = await import("./constants.js");
const { buildAgentContextCapsule, redactSecrets } = await import("./capsule.js");
const { generateTrajectoryIdentity } = await import("./encrypt.js");
const { attributeAbsPath, attributionFromOpenleafDir } = await import("./paths.js");
const { decryptTurnFile, ingestHookStdin, processHookEvent } = await import("./recorder.js");
const { pendingPath, projectSpoolPath, readJsonlRecords } = await import("./spool.js");
const { ensureProjectCursorHooks, projectRecorderSidecar } = await import("./install.js");

const userConfigDir = path.join(projectsRoot, "user-config");
const stateRoot = path.join(projectsRoot, ".openleaf-runtime", "cursor-trajectories");
const opts = { projectsRoot, stateRoot, userConfigDir };

function paper(id: string): string {
  return path.join(projectsRoot, id);
}

function writePaper(id: string, extra?: { recipients?: string }): void {
  const dir = paper(id);
  fs.mkdirSync(path.join(dir, "sections"), { recursive: true });
  fs.writeFileSync(path.join(dir, "main.tex"), "\\documentclass{article}\\begin{document}Hi\\end{document}\n");
  fs.writeFileSync(path.join(dir, "openleaf.json"), `${JSON.stringify({ mainFile: "main.tex" }, null, 2)}\n`);
  if (extra?.recipients) {
    fs.mkdirSync(path.join(dir, "misc", "cursor-trajectories"), { recursive: true });
    fs.writeFileSync(path.join(dir, "misc", "cursor-trajectories", "recipients.txt"), `${extra.recipients}\n`);
  }
}

function basePayload(over: Record<string, unknown>): Record<string, unknown> {
  return {
    conversation_id: "conv-1",
    generation_id: "gen-1",
    session_id: "conv-1",
    model: "test-model",
    cursor_version: "1.0.0-test",
    workspace_roots: [path.dirname(projectsRoot)],
    ...over,
  };
}

describe("cursor trajectory recorder", () => {
  let identity: string;
  let recipient: string;

  before(async () => {
    fs.mkdirSync(userConfigDir, { recursive: true, mode: 0o700 });
    const key = await generateTrajectoryIdentity();
    identity = key.identity;
    recipient = key.recipient;
    writePaper("alpha", { recipients: recipient });
    writePaper("beta", { recipients: recipient });
  });

  after(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("attributes worktree paths to the branch being edited", () => {
    const tex = path.join(paper("alpha"), ".openleaf", "worktrees", "feature-1", "sections", "01.tex");
    const hit = attributeAbsPath(tex, projectsRoot);
    assert.deepEqual(hit, { projectId: "alpha", branchId: "feature-1" });
    assert.equal(isCursorTrajectoryRel("misc/cursor-trajectories/conv/gen.jsonl.age"), true);
    assert.equal(isCursorTrajectoryRel("sections/01.tex"), false);
    assert.equal(isAgentContextRel("misc/agent-context/conv/gen.json"), true);
    assert.equal(isAgentContextRel("sections/01.tex"), false);
  });

  it("buffers prompts until a paper is identified, then encrypts a raw thinking turn", async () => {
    const conv = "conv-think";
    await processHookEvent(
      basePayload({
        conversation_id: conv,
        generation_id: "g-think",
        hook_event_name: "beforeSubmitPrompt",
        prompt: "Tighten the abstract",
      }),
      opts,
    );
    await processHookEvent(
      basePayload({
        conversation_id: conv,
        generation_id: "g-think",
        hook_event_name: "afterAgentThought",
        text: "I will edit sections/01_intro.tex because the claim is vague.",
        duration_ms: 12,
      }),
      opts,
    );
    const pending = await readJsonlRecords(pendingPath(stateRoot, conv, "g-think"));
    assert.equal(pending.length, 2);
    assert.equal(pending[1]!.prevHash, pending[0]!.hash);

    const result = await processHookEvent(
      basePayload({
        conversation_id: conv,
        generation_id: "g-think",
        hook_event_name: "afterFileEdit",
        file_path: path.join(paper("alpha"), "sections", "01_intro.tex"),
        edits: [{ old_string: "vague", new_string: "precise" }],
      }),
      opts,
    );
    assert.equal(result.attributed[0]?.projectId, "alpha");

    const stop = await processHookEvent(
      basePayload({
        conversation_id: conv,
        generation_id: "g-think",
        hook_event_name: "stop",
        status: "completed",
      }),
      opts,
    );
    assert.equal(stop.spoolOnly, false);
    assert.ok(stop.encrypted && stop.encrypted.length === 1);

    const agePath = stop.encrypted![0]!;
    assert.match(agePath, /misc\/cursor-trajectories\/.+\/g-think\.jsonl\.age$/);
    assert.equal(fs.existsSync(projectSpoolPath(paper("alpha"), conv, "g-think")), false);
    assert.equal(fs.existsSync(pendingPath(stateRoot, conv, "g-think")), false);

    const turned = await decryptTurnFile(agePath, identity);
    assert.equal(turned.header.kind, "turn");
    assert.equal(turned.header.eventCount, 4);
    assert.ok(turned.records.some((r) => r.hook === "afterAgentThought"));
    const thought = turned.records.find((r) => r.hook === "afterAgentThought");
    assert.equal((thought?.payload as { text?: string }).text, "I will edit sections/01_intro.tex because the claim is vague.");
    const miscPlain = path.join(paper("alpha"), "misc", "cursor-trajectories");
    for (const entry of fs.readdirSync(miscPlain, { recursive: true, encoding: "utf8" })) {
      assert.equal(String(entry).endsWith(".jsonl"), false);
    }

    assert.equal(stop.capsules?.length, 1);
    const capsulePath = stop.capsules![0]!;
    assert.match(capsulePath, /misc\/agent-context\/.+\/g-think\.json$/);
    const capsule = JSON.parse(fs.readFileSync(capsulePath, "utf8")) as {
      objective: string | null;
      changedFiles: string[];
      kind: string;
    };
    assert.equal(capsule.kind, "agent-context");
    assert.equal(capsule.objective, "Tighten the abstract");
    assert.ok(capsule.changedFiles.includes("sections/01_intro.tex"));
    const capsuleText = fs.readFileSync(capsulePath, "utf8");
    assert.equal(capsuleText.includes("the claim is vague"), false);
  });

  it("writes the complete turn to every paper a generation touches", async () => {
    const conv = "conv-multi";
    await processHookEvent(
      basePayload({
        conversation_id: conv,
        generation_id: "g-multi",
        hook_event_name: "beforeSubmitPrompt",
        prompt: "Sync both papers",
      }),
      opts,
    );
    await processHookEvent(
      basePayload({
        conversation_id: conv,
        generation_id: "g-multi",
        hook_event_name: "afterFileEdit",
        file_path: path.join(paper("alpha"), "main.tex"),
        edits: [{ old_string: "Hi", new_string: "Hello" }],
      }),
      opts,
    );
    await processHookEvent(
      basePayload({
        conversation_id: conv,
        generation_id: "g-multi",
        hook_event_name: "afterFileEdit",
        file_path: path.join(paper("beta"), "main.tex"),
        edits: [{ old_string: "Hi", new_string: "Hello" }],
      }),
      opts,
    );
    const stop = await processHookEvent(
      basePayload({
        conversation_id: conv,
        generation_id: "g-multi",
        hook_event_name: "stop",
        status: "completed",
      }),
      opts,
    );
    assert.equal(stop.encrypted?.length, 2);
    const a = await decryptTurnFile(stop.encrypted!.find((p) => p.includes(`${path.sep}alpha${path.sep}`))!, identity);
    const b = await decryptTurnFile(stop.encrypted!.find((p) => p.includes(`${path.sep}beta${path.sep}`))!, identity);
    assert.equal(a.records.length, b.records.length);
    assert.deepEqual(a.header.projectIds.slice().sort(), ["alpha", "beta"]);
    assert.ok(a.records.some((r) => r.hook === "beforeSubmitPrompt"));
  });

  it("keeps a private spool and never writes portable plaintext when recipients are missing", async () => {
    writePaper("gamma");
    const conv = "conv-norecip";
    await processHookEvent(
      basePayload({
        conversation_id: conv,
        generation_id: "g-none",
        hook_event_name: "afterFileEdit",
        file_path: path.join(paper("gamma"), "main.tex"),
        edits: [{ old_string: "Hi", new_string: "No key" }],
      }),
      opts,
    );
    const stop = await processHookEvent(
      basePayload({
        conversation_id: conv,
        generation_id: "g-none",
        hook_event_name: "stop",
        status: "completed",
      }),
      opts,
    );
    assert.equal(stop.spoolOnly, true);
    assert.equal(stop.encrypted?.length, 0);
    assert.equal(fs.existsSync(projectSpoolPath(paper("gamma"), conv, "g-none")), true);
    const misc = path.join(paper("gamma"), "misc", "cursor-trajectories");
    assert.equal(fs.existsSync(misc), false);
    assert.equal(stop.capsules?.length, 1);
    assert.equal(fs.existsSync(stop.capsules![0]!), true);
  });

  it("deduplicates the same tool event and survives a crash mid-turn", async () => {
    const conv = "conv-crash";
    const tool = {
      conversation_id: conv,
      generation_id: "g-crash",
      hook_event_name: "postToolUse",
      tool_name: "Read",
      tool_use_id: "tool-99",
      tool_input: { path: path.join(paper("alpha"), "main.tex") },
      tool_output: '{"ok":true}',
    };
    const first = await processHookEvent(basePayload(tool), opts);
    const dup = await processHookEvent(basePayload(tool), opts);
    assert.equal(first.ingested, true);
    assert.equal(dup.skipped, "duplicate");

    const spool = projectSpoolPath(paper("alpha"), conv, "g-crash");
    assert.equal(fs.existsSync(spool), true);
    const before = await readJsonlRecords(spool);

    const resumed = await processHookEvent(
      basePayload({
        conversation_id: conv,
        generation_id: "g-crash",
        hook_event_name: "afterAgentResponse",
        text: "Read the intro.",
      }),
      opts,
    );
    assert.equal(resumed.ingested, true);
    const after = await readJsonlRecords(spool);
    assert.equal(after.length, before.length + 1);
    assert.equal(after[after.length - 1]!.prevHash, after[after.length - 2]!.hash);
  });

  it("encrypts into a branch worktree and ZIP/git only ship the ciphertext", async () => {
    const conv = "conv-branch";
    const branchId = "feature-zip";
    const wt = path.join(paper("alpha"), ".openleaf", "worktrees", branchId);
    fs.mkdirSync(path.join(wt, "sections"), { recursive: true });
    fs.writeFileSync(path.join(wt, "main.tex"), "branch copy\n");
    fs.writeFileSync(path.join(paper("alpha"), ".gitignore"), ".openleaf/\n");

    const stop = await (async () => {
      await processHookEvent(
        basePayload({
          conversation_id: conv,
          generation_id: "g-branch",
          hook_event_name: "afterFileEdit",
          file_path: path.join(wt, "main.tex"),
          edits: [{ old_string: "branch copy", new_string: "edited on branch" }],
        }),
        opts,
      );
      return processHookEvent(
        basePayload({
          conversation_id: conv,
          generation_id: "g-branch",
          hook_event_name: "stop",
          status: "completed",
        }),
        opts,
      );
    })();

    const ageRel = `misc/cursor-trajectories/${conv}/g-branch.jsonl.age`;
    const ageAbs = path.join(wt, ageRel);
    assert.equal(fs.existsSync(ageAbs), true);
    assert.ok(stop.encrypted?.some((p) => p === ageAbs));

    const zipMain = collectZipFiles(paper("alpha"));
    const zipBranch = collectZipFiles(wt);
    assert.ok(zipBranch.includes(ageRel));
    assert.equal(zipMain.some((f) => f.startsWith(".openleaf/")), false);
    assert.equal(
      zipBranch.some((f) => f.startsWith(".openleaf/cursor-trajectories/spool/")),
      false,
    );

    const commit = await autoCommitProject("alpha", { message: "trajectory artifact" });
    assert.equal(commit.committed, true);
    const { stdout } = await execFileAsync("git", ["ls-files"], { cwd: paper("alpha") });
    const tracked = String(stdout)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    // Worktree files sit under gitignored `.openleaf/`; they are not on the main checkout.
    assert.equal(tracked.some((f) => f.includes(".openleaf/worktrees")), false);
    assert.equal(tracked.some((f) => f.includes(".openleaf/cursor-trajectories/spool")), false);
  });

  it("includes encrypted artifacts from the main tree in ZIP and git", async () => {
    const conv = "conv-git";
    await processHookEvent(
      basePayload({
        conversation_id: conv,
        generation_id: "g-git",
        hook_event_name: "afterFileEdit",
        file_path: path.join(paper("beta"), "main.tex"),
        edits: [{ old_string: "Hi", new_string: "Git me" }],
      }),
      opts,
    );
    const stop = await processHookEvent(
      basePayload({
        conversation_id: conv,
        generation_id: "g-git",
        hook_event_name: "stop",
        status: "completed",
      }),
      opts,
    );
    const ageRel = stop.encrypted![0]!.slice(paper("beta").length + 1).replace(/\\/g, "/");
    const zipped = collectZipFiles(paper("beta"));
    assert.ok(zipped.includes(ageRel));
    assert.equal(zipped.some((f) => f.includes(".openleaf/")), false);

    fs.writeFileSync(path.join(paper("beta"), ".gitignore"), ".openleaf/\n");
    const commit = await autoCommitProject("beta", { message: "store encrypted trajectory" });
    assert.equal(commit.committed, true);
    const { stdout } = await execFileAsync("git", ["ls-files"], { cwd: paper("beta") });
    const tracked = String(stdout).split("\n").map((l) => l.trim());
    assert.ok(tracked.includes(ageRel));
    assert.equal(tracked.some((f) => f.includes("cursor-trajectories/spool")), false);
    const capsuleRel = stop.capsules![0]!.slice(paper("beta").length + 1).replace(/\\/g, "/");
    assert.ok(zipped.includes(capsuleRel));
    assert.ok(tracked.includes(capsuleRel));
  });

  it("sessionEnd encrypts an opaque transcript copy when present", async () => {
    const conv = "conv-tr";
    const transcript = path.join(projectsRoot, "cursor-transcript.jsonl");
    fs.writeFileSync(transcript, '{"role":"assistant","text":"secret thought"}\n');
    await processHookEvent(
      basePayload({
        conversation_id: conv,
        generation_id: "g-tr",
        hook_event_name: "afterFileEdit",
        file_path: path.join(paper("alpha"), "main.tex"),
        edits: [{ old_string: "a", new_string: "b" }],
        transcript_path: transcript,
      }),
      opts,
    );
    const end = await processHookEvent(
      basePayload({
        conversation_id: conv,
        generation_id: "g-tr",
        hook_event_name: "sessionEnd",
        reason: "completed",
        transcript_path: transcript,
      }),
      opts,
    );
    assert.ok(end.encrypted?.some((p) => p.endsWith(`${path.sep}transcript.age`)));
  });

  it("runs the hook CLI fail-open against stdin JSON", async () => {
    const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const tsxRoot = path.join(REPO_ROOT, "node_modules/.bin/tsx");
    const tsxServer = path.join(REPO_ROOT, "server/node_modules/.bin/tsx");
    const tsx = fs.existsSync(tsxRoot) ? tsxRoot : tsxServer;
    const payload = JSON.stringify(
      basePayload({
        conversation_id: "conv-cli",
        generation_id: "g-cli",
        hook_event_name: "beforeSubmitPrompt",
        prompt: "from cli",
      }),
    );
    const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      const child = spawn(tsx, [cli], {
        env: {
          ...process.env,
          OPENLEAF_PROJECTS_ROOT: projectsRoot,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += String(d);
      });
      child.stderr.on("data", (d) => {
        stderr += String(d);
      });
      child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
      child.stdin.write(payload);
      child.stdin.end();
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout.trim(), /^\{\}$/);
  });

  it("accepts ingestHookStdin garbage without throwing", async () => {
    const empty = await ingestHookStdin("  ");
    assert.equal(empty.skipped, "empty");
    const bad = await ingestHookStdin("not-json", opts);
    assert.equal(bad.skipped, "empty");
  });

  it("stamps Cursor hooks into a paper and records a standalone workspace session", async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-standalone-"));
    const dir = path.join(elsewhere, "Transmissions_paper");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "openleaf.json"), `${JSON.stringify({ mainFile: "main.tex" }, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, "main.tex"), "hello\n");
    fs.mkdirSync(path.join(dir, "misc", "cursor-trajectories"), { recursive: true });
    fs.writeFileSync(path.join(dir, "misc", "cursor-trajectories", "recipients.txt"), `${recipient}\n`);

    await ensureProjectCursorHooks(dir, { openleafRoot: REPO_ROOT });
    assert.equal(fs.existsSync(path.join(dir, ".cursor", "hooks.json")), true);
    assert.equal(fs.existsSync(path.join(dir, ".cursor", "hooks", "record-trajectory.sh")), true);
    const sidecar = JSON.parse(fs.readFileSync(projectRecorderSidecar(dir), "utf8")) as { openleafRoot: string };
    assert.equal(sidecar.openleafRoot, REPO_ROOT);
    assert.deepEqual(attributionFromOpenleafDir(dir), {
      projectId: "Transmissions_paper",
      branchId: "main",
      root: path.resolve(dir),
    });

    const conv = "conv-standalone";
    const prompt = await processHookEvent(
      basePayload({
        conversation_id: conv,
        generation_id: "g-st",
        hook_event_name: "beforeSubmitPrompt",
        prompt: "Revise the methods",
        workspace_roots: [dir],
      }),
      opts,
    );
    assert.equal(prompt.attributed[0]?.projectId, "Transmissions_paper");
    assert.equal(prompt.attributed[0]?.root, path.resolve(dir));

    const stop = await processHookEvent(
      basePayload({
        conversation_id: conv,
        generation_id: "g-st",
        hook_event_name: "stop",
        status: "completed",
        workspace_roots: [dir],
      }),
      opts,
    );
    assert.ok(stop.encrypted?.some((p) => p.startsWith(path.resolve(dir) + path.sep)));
    const age = stop.encrypted!.find((p) => p.endsWith(".jsonl.age"))!;
    const turned = await decryptTurnFile(age, identity);
    assert.ok(turned.records.some((r) => r.hook === "beforeSubmitPrompt"));
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it("redacts secrets, emails, and absolute paths from shareable text", () => {
    const out = redactSecrets(
      "sk-abcdefghijklmnopqrstuvwxyz123456 mail ada@example.com path /Users/petchma/Papers/main.tex https://x.test/a?token=secret",
    );
    assert.equal(out.includes("sk-abcdefghijklmnopqrstuvwxyz123456"), false);
    assert.equal(out.includes("ada@example.com"), false);
    assert.equal(out.includes("/Users/petchma"), false);
    assert.equal(out.includes("token=secret"), false);
    assert.ok(out.includes("[redacted-key]"));
    assert.ok(out.includes("[redacted-email]"));
  });

  it("extracts a capsule without thinking, stdout, secrets, or absolute paths", () => {
    const root = paper("alpha");
    const rec = (hook: string, payload: unknown, seq: number): TrajectoryRecord => ({
      v: 1,
      seq,
      prevHash: "p",
      hash: "h",
      ts: "2026-01-01T00:00:00.000Z",
      hook,
      conversation_id: "c",
      generation_id: "g",
      session_id: "c",
      model: null,
      model_id: null,
      cursor_version: null,
      attributed: [],
      payload,
    });
    const capsule = buildAgentContextCapsule({
      records: [
        rec(
          "beforeSubmitPrompt",
          {
            prompt:
              "Tighten methods. sk-abcdefghijklmnopqrstuvwxyz123456 contact bob@lab.edu under /Users/petchma/Papers/alpha/main.tex",
          },
          1,
        ),
        rec("afterAgentThought", { text: "SECRET_THINKING_BLOCK I will leak this" }, 2),
        rec(
          "afterFileEdit",
          {
            file_path: path.join(root, "main.tex"),
            edits: [{ old_string: "Hi", new_string: "SECRET_EDIT_BODY" }],
          },
          3,
        ),
        rec(
          "postToolUse",
          {
            tool_name: "Shell",
            tool_input: { command: "npm test -- --run" },
            tool_output: '{"exitCode":0,"stdout":"ALL_STDOUT_LEAK"}',
          },
          4,
        ),
        rec(
          "afterAgentResponse",
          {
            text: "I decided to rephrase the claim because it overreached and because the previous wording mixed DREAM-only skill with the pair-mode scheduler requirement in a way that later readers would not be able to audit. What remains open? Next: check figure 2.",
          },
          5,
        ),
      ],
      conversationId: "c",
      generationId: "g",
      root,
      writtenAt: "2026-01-01T00:00:00.000Z",
    });
    const dump = JSON.stringify(capsule);
    assert.equal(dump.includes("SECRET_THINKING_BLOCK"), false);
    assert.equal(dump.includes("ALL_STDOUT_LEAK"), false);
    assert.equal(dump.includes("SECRET_EDIT_BODY"), false);
    assert.equal(dump.includes("sk-abcdefghijklmnopqrstuvwxyz123456"), false);
    assert.equal(dump.includes("bob@lab.edu"), false);
    assert.equal(dump.includes(root), false);
    assert.equal(dump.includes("npm test"), false);
    assert.ok(capsule.changedFiles.includes("main.tex"));
    assert.ok(capsule.verification.some((v) => v.check === "tests" && v.status === "passed"));
    assert.ok(capsule.objective?.includes("[redacted-key]"));
    assert.ok(capsule.objective?.includes("Tighten methods"));
    assert.equal(capsule.objective?.endsWith("…"), false);
    assert.ok(capsule.decisions.length > 0);
    assert.ok(
      capsule.decisions[0]!.statement.includes(
        "later readers would not be able to audit",
      ),
    );
    assert.equal(capsule.decisions[0]!.statement.endsWith("…"), false);
    assert.ok(capsule.openQuestions.length > 0);
    assert.ok(capsule.nextSteps.length > 0);
    assert.ok(capsule.outcome?.includes("I decided to rephrase the claim"));
  });

  it("stores a redacted final reply as outcome when the turn is only a summary", () => {
    const root = paper("alpha");
    const rec = (hook: string, payload: unknown, seq: number): TrajectoryRecord => ({
      v: 1,
      seq,
      prevHash: "p",
      hash: "h",
      ts: "2026-01-01T00:00:00.000Z",
      hook,
      conversation_id: "c",
      generation_id: "g",
      session_id: "c",
      model: null,
      model_id: null,
      cursor_version: null,
      attributed: [],
      payload,
    });
    const capsule = buildAgentContextCapsule({
      records: [
        rec("beforeSubmitPrompt", { prompt: "okay quick follow up summarise what you just did" }, 1),
        rec("afterAgentThought", { text: "SECRET_THINKING_BLOCK do not copy" }, 2),
        rec(
          "afterAgentResponse",
          {
            text: "I added a % comment after the Problem Statement label in article.tex and left the compiled text alone.",
          },
          3,
        ),
      ],
      conversationId: "c",
      generationId: "g",
      root,
      writtenAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(capsule.objective, "okay quick follow up summarise what you just did");
    assert.equal(
      capsule.outcome,
      "I added a % comment after the Problem Statement label in article.tex and left the compiled text alone.",
    );
    assert.equal(capsule.outcome?.includes("SECRET_THINKING_BLOCK"), false);
    assert.deepEqual(capsule.decisions, []);
    assert.deepEqual(capsule.changedFiles, []);
  });

  it("binds the capsule to the current HEAD and a content digest", async () => {
    writePaper("bind");
    const dir = paper("bind");
    const commit = await autoCommitProject("bind", { message: "base" });
    assert.equal(commit.committed, true);
    assert.ok(commit.hash);
    fs.writeFileSync(path.join(dir, "main.tex"), "changed after commit\n");

    const conv = "conv-bind";
    await processHookEvent(
      basePayload({
        conversation_id: conv,
        generation_id: "g-bind",
        hook_event_name: "afterFileEdit",
        file_path: path.join(dir, "main.tex"),
        edits: [{ old_string: "Hi", new_string: "changed after commit" }],
      }),
      opts,
    );
    const stop = await processHookEvent(
      basePayload({
        conversation_id: conv,
        generation_id: "g-bind",
        hook_event_name: "stop",
        status: "completed",
      }),
      opts,
    );
    assert.equal(stop.capsules?.length, 1);
    const capsule = JSON.parse(fs.readFileSync(stop.capsules![0]!, "utf8")) as {
      baseCommit: string | null;
      diffDigest: string | null;
      changedFiles: string[];
    };
    assert.equal(capsule.baseCommit, commit.hash);
    assert.match(capsule.diffDigest ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.ok(capsule.changedFiles.includes("main.tex"));
  });
});
