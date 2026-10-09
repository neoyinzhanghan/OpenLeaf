import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-file-access-"));
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
const { createProject, deletePath, projectDir, renamePath, writeFile } = await import("./projectFs.js");
const {
  assertCanWrite,
  effectiveAccess,
  normalizeAccessPath,
  putFileAccessRules,
  listFileAccess,
  revertDeniedYjsFiles,
  resolveActor,
  snapshotYjsFiles,
} = await import("./fileAccess.js");

const actors = ["local", "device", "guest", "ai"] as const;
type Actor = (typeof actors)[number];

function denied(err: unknown): { status?: number; code?: string; reason?: string } {
  return err as { status?: number; code?: string; reason?: string };
}

async function expectDeny(actor: Actor, rel: string) {
  await assert.rejects(() => assertCanWrite("matrix", rel, actor), (err: unknown) => {
    const e = denied(err);
    assert.equal(e.status, 403);
    assert.ok(e.code === "FILE_PROTECTED" || e.code === "FILE_LOCKED");
    return true;
  });
}

async function expectAllow(actor: Actor, rel: string) {
  await assert.doesNotReject(() => assertCanWrite("matrix", rel, actor));
}

function git(dir: string, args: string[]) {
  execFileSync("git", args, {
    cwd: dir,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "OpenLeaf",
      GIT_AUTHOR_EMAIL: "openleaf@local",
      GIT_COMMITTER_NAME: "OpenLeaf",
      GIT_COMMITTER_EMAIL: "openleaf@local",
    },
  });
}

describe("file access", { concurrency: 1 }, () => {
  before(async () => {
    await createProject("matrix", "missing-template");
    const dir = projectDir("matrix");
    fs.mkdirSync(path.join(dir, "sections"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sections", "main.tex"), "x\n");
    fs.writeFileSync(path.join(dir, "references.bib"), "% bib\n");
    fs.writeFileSync(path.join(dir, "notes.tex"), "n\n");
    await putFileAccessRules("matrix", "local", {
      upsert: [
        { path: "sections", level: "host" },
        { path: "references.bib", level: "local" },
      ],
    });
  });

  after(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("normalizes path tricks before matching", () => {
    assert.equal(normalizeAccessPath("sections\\main.tex"), "sections/main.tex");
    assert.equal(normalizeAccessPath("./sections/main.tex"), "sections/main.tex");
    assert.equal(normalizeAccessPath("sections/main.tex/"), "sections/main.tex");
    assert.equal(normalizeAccessPath("sections/../main.tex"), "main.tex");
    const composed = "caf\u00e9.tex";
    const decomposed = "cafe\u0301.tex";
    assert.equal(normalizeAccessPath(decomposed), normalizeAccessPath(composed));
  });

  it("matrix: actor × protection × operation", async () => {
    const cases: { rel: string; kind: "protected" | "local" | "host" | "none" }[] = [
      { rel: "openleaf.json", kind: "protected" },
      { rel: "references.bib", kind: "local" },
      { rel: "sections/main.tex", kind: "host" },
      { rel: "notes.tex", kind: "none" },
    ];
    const ops = ["write", "create", "rename-in", "rename-out", "delete", "delete-parent", "upload", "ai-edit"] as const;

    for (const actor of actors) {
      for (const row of cases) {
        for (const op of ops) {
          const target =
            op === "create"
              ? row.kind === "host"
                ? "sections/new.tex"
                : row.kind === "none"
                  ? "brand-new.tex"
                  : row.rel
              : op === "rename-in"
                ? row.kind === "host"
                  ? "sections/moved.tex"
                  : row.rel
                : op === "delete-parent" && row.kind === "host"
                  ? "sections"
                  : row.rel;
          const checkActor = op === "ai-edit" ? "ai" : actor;
          if (op === "ai-edit" && actor !== "ai") continue;
          const access = await effectiveAccess("matrix", target, checkActor);
          const locked =
            row.kind === "protected"
              ? checkActor !== "local"
              : row.kind === "local"
                ? checkActor !== "local"
                : row.kind === "host"
                  ? checkActor === "guest" || checkActor === "ai"
                  : false;
          if (locked) {
            assert.equal(access.canWrite, false, `${checkActor} ${op} ${target}`);
            await expectDeny(checkActor, target);
          } else {
            assert.equal(access.canWrite, true, `${checkActor} ${op} ${target}`);
            await expectAllow(checkActor, target);
          }
        }
      }
    }
  });

  it("refuses symlink escapes into a protected or locked path", async () => {
    const dir = projectDir("matrix");
    const outside = path.join(sandbox, "secret.tex");
    fs.writeFileSync(outside, "secret\n");
    fs.symlinkSync(path.join(dir, "openleaf.json"), path.join(dir, "link-settings.json"));
    fs.symlinkSync(path.join(dir, "references.bib"), path.join(dir, "link-bib.json"));
    await expectDeny("device", "link-settings.json");
    await expectDeny("guest", "link-bib.json");
    await expectAllow("local", "link-settings.json");
    await expectDeny("guest", "REFERENCES.BIB");
    await expectDeny("guest", "./references.bib");
    await expectDeny("guest", "references.bib/");
    await expectDeny("guest", "sections\\main.tex");
    await expectDeny("device", ".\\openleaf.json");
    const composed = "caf\u00e9.tex";
    const decomposed = "cafe\u0301.tex";
    await putFileAccessRules("matrix", "local", { upsert: [{ path: composed, level: "host" }] });
    await expectDeny("guest", decomposed);
    await putFileAccessRules("matrix", "local", { delete: [composed] });
  });

  it("lets a device add a local rule but not remove it", async () => {
    await putFileAccessRules("matrix", "device", { upsert: [{ path: "notes.tex", level: "local" }] });
    const added = await listFileAccess("matrix");
    assert.ok(added.rules.some((rule) => rule.path === "notes.tex" && rule.level === "local"));
    await assert.rejects(
      () => putFileAccessRules("matrix", "device", { delete: ["notes.tex"] }),
      (err: unknown) => denied(err).status === 403,
    );
    await assert.rejects(
      () => putFileAccessRules("matrix", "guest", { upsert: [{ path: "notes.tex", level: "everyone" }] }),
      (err: unknown) => denied(err).status === 403,
    );
    await assert.rejects(
      () => putFileAccessRules("matrix", "ai", { delete: ["notes.tex"] }),
      (err: unknown) => denied(err).status === 403,
    );
    await putFileAccessRules("matrix", "local", { delete: ["notes.tex"] });
  });

  it("keeps rules in openleaf.json across a fresh read and a branch checkout", async () => {
    await putFileAccessRules("matrix", "local", { upsert: [{ path: "notes.tex", level: "host" }] });
    const raw = fs.readFileSync(path.join(projectDir("matrix"), "openleaf.json"), "utf8");
    assert.match(raw, /fileAccess/);
    const again = await listFileAccess("matrix");
    assert.ok(again.rules.some((rule) => rule.path === "notes.tex"));

    const dir = projectDir("matrix");
    const current = execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim();
    git(dir, ["add", "openleaf.json"]);
    git(dir, ["commit", "-m", "rules"]);
    git(dir, ["checkout", "-b", "other-access"]);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "openleaf.json"), "utf8")) as {
      fileAccess?: { rules: { path: string }[] };
    };
    cfg.fileAccess = { rules: [] };
    fs.writeFileSync(path.join(dir, "openleaf.json"), `${JSON.stringify(cfg, null, 2)}\n`);
    git(dir, ["add", "openleaf.json"]);
    git(dir, ["commit", "-m", "clear"]);
    git(dir, ["checkout", current]);
    const back = await listFileAccess("matrix");
    assert.ok(back.rules.some((rule) => rule.path === "notes.tex"));
  });

  it("drops a guest Yjs update to a locked file before it can be flushed", async () => {
    await putFileAccessRules("matrix", "local", { upsert: [{ path: "notes.tex", level: "host" }] });
    const doc = new Y.Doc();
    const files = doc.getMap<Y.Text>("files");
    const text = new Y.Text();
    text.insert(0, "original\n");
    files.set("notes.tex", text);
    const guest = new Y.Doc();
    Y.applyUpdate(guest, Y.encodeStateAsUpdate(doc));
    guest.getMap<Y.Text>("files").get("notes.tex")!.insert(0, "GUEST ");
    const before = snapshotYjsFiles(doc);
    const update = Y.encodeStateAsUpdate(guest, Y.encodeStateVector(doc));
    Y.applyUpdate(doc, update, "guest");
    await revertDeniedYjsFiles(doc, "matrix", "guest", before);
    assert.equal(doc.getMap<Y.Text>("files").get("notes.tex")!.toString(), "original\n");
    await writeFile("matrix", "notes.tex", doc.getMap<Y.Text>("files").get("notes.tex")!.toString());
    assert.equal(fs.readFileSync(path.join(projectDir("matrix"), "notes.tex"), "utf8"), "original\n");
    await putFileAccessRules("matrix", "local", { delete: ["notes.tex"] });
    const open = snapshotYjsFiles(doc);
    guest.getMap<Y.Text>("files").get("notes.tex")!.insert(0, "OK ");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(guest, Y.encodeStateVector(doc)));
    await revertDeniedYjsFiles(doc, "matrix", "guest", open);
    assert.match(doc.getMap<Y.Text>("files").get("notes.tex")!.toString(), /OK /);
    await putFileAccessRules("matrix", "local", { upsert: [{ path: "notes.tex", level: "host" }] });
    const locked = snapshotYjsFiles(doc);
    const sneak = new Y.Doc();
    Y.applyUpdate(sneak, Y.encodeStateAsUpdate(doc));
    sneak.getMap<Y.Text>("files").get("notes.tex")!.insert(0, "LATE ");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(sneak, Y.encodeStateVector(doc)));
    await revertDeniedYjsFiles(doc, "matrix", "guest", locked);
    assert.equal(doc.getMap<Y.Text>("files").get("notes.tex")!.toString().startsWith("LATE "), false);
  });

  it("moves a lock when a file or folder is renamed, and keeps it after delete", async () => {
    await createProject("rename-lock", "missing-template");
    const dir = projectDir("rename-lock");
    fs.mkdirSync(path.join(dir, "sections"), { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.tex"), "n\n");
    fs.writeFileSync(path.join(dir, "sections", "body.tex"), "b\n");
    fs.writeFileSync(path.join(dir, "sections", "secret.tex"), "s\n");
    await putFileAccessRules("rename-lock", "local", {
      upsert: [
        { path: "notes.tex", level: "local" },
        { path: "sections", level: "local" },
        { path: "sections/secret.tex", level: "host" },
      ],
    });
    await renamePath("rename-lock", "notes.tex", "notes2.tex");
    await renamePath("rename-lock", "sections", "chapters");
    await assert.rejects(() => assertCanWrite("rename-lock", "notes2.tex", "device"), (err: unknown) => {
      assert.equal(denied(err).status, 403);
      return true;
    });
    await assert.rejects(() => assertCanWrite("rename-lock", "chapters/body.tex", "device"), (err: unknown) => {
      assert.equal(denied(err).status, 403);
      return true;
    });
    await assert.rejects(() => assertCanWrite("rename-lock", "chapters/secret.tex", "guest"), (err: unknown) => {
      assert.equal(denied(err).status, 403);
      return true;
    });
    await assert.doesNotReject(() => assertCanWrite("rename-lock", "chapters/secret.tex", "device"));
    await deletePath("rename-lock", "notes2.tex");
    const listed = await listFileAccess("rename-lock");
    const kept = listed.rules.find((rule) => rule.path === "notes2.tex");
    assert.ok(kept, "deleted path must keep its rule");
    assert.equal(kept?.missing, true);
    await writeFile("rename-lock", "notes2.tex", "again\n");
    await assert.rejects(() => assertCanWrite("rename-lock", "notes2.tex", "device"), (err: unknown) => {
      assert.equal(denied(err).status, 403);
      return true;
    });
  });

  it("resolves actors from the request access lane", () => {
    assert.equal(resolveActor({ access: { mode: "host", remote: false } }), "local");
    assert.equal(resolveActor({ access: { mode: "host", remote: true } }), "device");
    assert.equal(
      resolveActor({
        access: {
          mode: "guest",
          session: {} as never,
          guest: {} as never,
        },
      }),
      "guest",
    );
    assert.equal(resolveActor({ access: { mode: "host" }, ai: true }), "ai");
  });
});
