import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { redactText } from "./sanitize.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bin = path.join(repoRoot, "cli/bin/openleaf.js");
const healthEntry = path.join(repoRoot, "cli/fixtures/health-server.mjs");

function temp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function run(args: string[], extra: Record<string, string | undefined>, input?: string) {
  const env = { ...process.env, ...extra };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
  }
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    input,
    timeout: 30_000,
  });
}

function isolated(port?: number): Record<string, string> {
  const configDir = temp("openleaf-cfg-");
  const projects = temp("openleaf-papers-");
  const env: Record<string, string> = {
    OPENLEAF_CONFIG_DIR: configDir,
    OPENLEAF_PROJECTS_ROOT: projects,
    OPENLEAF_HOST: "127.0.0.1",
  };
  if (port) env.OPENLEAF_PORT = String(port);
  return env;
}

describe("openleaf cli", { concurrency: 1 }, () => {
  it("prints an entry point without waiting when stdin is not a terminal", () => {
    const result = run([], isolated());
    assert.equal(result.status, 0);
    assert.match(result.stdout, /OpenLeaf/);
    assert.match(result.stdout, /not interactive/);
    assert.doesNotMatch(result.stdout, /admin-neo|Admin Neo/);
  });

  it("sets up a new install, then a second run does not duplicate the sample or reset identity", () => {
    const env = isolated();
    const projects = env.OPENLEAF_PROJECTS_ROOT!;
    const first = run(
      [
        "setup",
        "--non-interactive",
        "--display-name",
        "Ada Lovelace",
        "--projects-dir",
        projects,
        "--access",
        "localhost",
        "--skip-build",
        "--skip-start",
        "--skip-compile",
      ],
      env,
    );
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const local = JSON.parse(fs.readFileSync(path.join(env.OPENLEAF_CONFIG_DIR!, "local.json"), "utf8")) as {
      host: string;
      access: string;
      user: { displayName: string };
      defaultIdentities: Array<{ id: string; name: string }>;
    };
    assert.equal(local.host, "127.0.0.1");
    assert.equal(local.access, "localhost");
    assert.equal(local.user.displayName, "Ada Lovelace");
    assert.equal(local.defaultIdentities[0]?.id, "ada-lovelace");
    assert.equal(local.defaultIdentities[0]?.name, "Ada Lovelace");
    const welcome = path.join(projects, "openleaf-welcome", "main.tex");
    const before = fs.readFileSync(welcome, "utf8");
    const second = run(
      ["setup", "--non-interactive", "--skip-build", "--skip-start", "--skip-compile"],
      env,
    );
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.equal(fs.readFileSync(welcome, "utf8"), before);
    const again = JSON.parse(fs.readFileSync(path.join(env.OPENLEAF_CONFIG_DIR!, "local.json"), "utf8")) as {
      defaultIdentities: Array<{ id: string }>;
    };
    assert.equal(again.defaultIdentities[0]?.id, "ada-lovelace");
    const dirs = fs.readdirSync(projects).filter((name) => name.startsWith("openleaf-welcome"));
    assert.deepEqual(dirs, ["openleaf-welcome"]);
  });

  it("keeps an existing install's projects path and identities", () => {
    const env = isolated();
    const customProjects = temp("openleaf-custom-");
    fs.writeFileSync(
      path.join(env.OPENLEAF_CONFIG_DIR!, "local.json"),
      `${JSON.stringify(
        {
          host: "0.0.0.0",
          projectsRoot: customProjects,
          user: { displayName: "Kept Author" },
          defaultIdentities: [{ id: "kept-author", name: "Kept Author", color: "#112233" }],
          extraField: { keep: true },
        },
        null,
        2,
      )}\n`,
    );
    fs.mkdirSync(path.join(customProjects, "paper"), { recursive: true });
    fs.writeFileSync(path.join(customProjects, "paper", "main.tex"), "kept\n");
    const result = run(
      ["setup", "--non-interactive", "--skip-build", "--skip-start", "--skip-compile"],
      { ...env, OPENLEAF_PROJECTS_ROOT: undefined },
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const local = JSON.parse(fs.readFileSync(path.join(env.OPENLEAF_CONFIG_DIR!, "local.json"), "utf8")) as {
      host: string;
      projectsRoot: string;
      defaultIdentities: Array<{ name: string }>;
      extraField: { keep: boolean };
    };
    assert.equal(local.host, "0.0.0.0");
    assert.equal(local.projectsRoot, customProjects);
    assert.equal(local.defaultIdentities[0]?.name, "Kept Author");
    assert.equal(local.extraField.keep, true);
    assert.equal(fs.existsSync(path.join(customProjects, "paper", "main.tex")), true);
    assert.equal(fs.existsSync(path.join(customProjects, "openleaf-welcome", "main.tex")), true);
  });

  it("reports broken configuration and prints JSON without decoration", () => {
    const env = isolated();
    fs.writeFileSync(path.join(env.OPENLEAF_CONFIG_DIR!, "local.json"), "{");
    const result = run(["doctor", "--json"], env);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const body = JSON.parse(result.stdout) as { schemaVersion: number; checks: Array<{ id: string; status: string }> };
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.checks.find((check) => check.id === "config-parse")?.status, "fail");
    assert.doesNotMatch(result.stdout, /⠋|spinner/);
  });

  it("refuses to create a missing projects parent unless --yes is passed", () => {
    const env = isolated();
    const missing = path.join(temp("openleaf-parent-"), "nope", "projects");
    fs.writeFileSync(
      path.join(env.OPENLEAF_CONFIG_DIR!, "local.json"),
      `${JSON.stringify({ projectsRoot: missing, user: { displayName: "Ada Lovelace" } })}\n`,
    );
    const denied = run(["doctor", "--fix", "--non-interactive"], { ...env, OPENLEAF_PROJECTS_ROOT: undefined });
    assert.equal(denied.status, 2, denied.stdout + denied.stderr);
    assert.match(denied.stdout, /--yes/);
    assert.equal(fs.existsSync(missing), false);
    const allowed = run(["doctor", "--fix", "--yes", "--non-interactive"], { ...env, OPENLEAF_PROJECTS_ROOT: undefined });
    assert.equal(fs.existsSync(missing), true, allowed.stdout + allowed.stderr);
  });

  it("starts, reports ready, refuses a second copy, and stops only its own process", async () => {
    const port = 19000 + Math.floor(Math.random() * 1000);
    const env: Record<string, string> = {
      ...isolated(port),
      OPENLEAF_SERVER_ENTRY: healthEntry,
    };
    const started = run(["start"], env);
    assert.equal(started.status, 0, started.stderr + started.stdout);
    assert.match(started.stdout, /Ready at/);
    const again = run(["start"], env);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.match(again.stdout, /Already running/);
    const status = run(["status", "--json"], env);
    const body = JSON.parse(status.stdout) as { schemaVersion: number; checks: Array<{ id: string; status: string }> };
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.checks.find((check) => check.id === "api-health")?.status, "pass");
    const meta = JSON.parse(
      fs.readFileSync(path.join(env.OPENLEAF_CONFIG_DIR!, "runtime", "instance.json"), "utf8"),
    ) as { pid: number };
    const stopped = run(["stop"], env);
    assert.equal(stopped.status, 0, stopped.stderr + stopped.stdout);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.throws(() => process.kill(meta.pid, 0));
  });

  it("does not kill an unrelated process that holds the port or a stale pid", async () => {
    const port = 20000 + Math.floor(Math.random() * 1000);
    const env: Record<string, string> = { ...isolated(port), OPENLEAF_SERVER_ENTRY: healthEntry };
    const blocker = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("other");
    });
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(port, "127.0.0.1", () => resolve());
      });
      const occupied = run(["start"], env);
      assert.equal(occupied.status, 1, occupied.stdout + occupied.stderr);
      assert.match(occupied.stdout + occupied.stderr, /will not stop/);
      const probe = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(await probe.text(), "other");
      await new Promise<void>((resolve) => blocker.close(() => resolve()));

      const pid = sleeper.pid!;
      fs.mkdirSync(path.join(env.OPENLEAF_CONFIG_DIR!, "runtime"), { recursive: true });
      fs.writeFileSync(
        path.join(env.OPENLEAF_CONFIG_DIR!, "runtime", "instance.json"),
        JSON.stringify({
          pid,
          instanceId: "not-this-install",
          port,
          host: "127.0.0.1",
          repoRoot,
          configDir: env.OPENLEAF_CONFIG_DIR,
          logFile: path.join(env.OPENLEAF_CONFIG_DIR!, "runtime", "openleaf.log"),
          startedAt: new Date().toISOString(),
          entry: healthEntry,
        }),
      );
      const started = run(["start"], env);
      assert.equal(started.status, 0, started.stderr + started.stdout);
      assert.equal(process.kill(pid, 0), true);
    } finally {
      sleeper.kill("SIGKILL");
      blocker.close();
      run(["stop"], env);
    }
  });

  it("clears stale metadata and still reports a down tunnel while localhost is healthy", async () => {
    const port = 21000 + Math.floor(Math.random() * 1000);
    const env: Record<string, string> = { ...isolated(port), OPENLEAF_SERVER_ENTRY: healthEntry };
    fs.writeFileSync(
      path.join(env.OPENLEAF_CONFIG_DIR!, "local.json"),
      `${JSON.stringify({ access: "remote", host: "127.0.0.1", port, user: { displayName: "Ada Lovelace", hostUsername: "ada-host" } })}\n`,
    );
    fs.mkdirSync(path.join(env.OPENLEAF_CONFIG_DIR!, "runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(env.OPENLEAF_CONFIG_DIR!, "runtime", "instance.json"),
      JSON.stringify({ pid: 2147483646, instanceId: "dead", port, host: "127.0.0.1" }),
    );
    fs.writeFileSync(
      path.join(env.OPENLEAF_CONFIG_DIR!, "host-gateway.json"),
      `${JSON.stringify({ status: "error", localOnly: true, dnsReady: false })}\n`,
    );
    const started = run(["start"], env);
    assert.equal(started.status, 0, started.stderr + started.stdout);
    const doctor = run(["doctor", "--json"], env);
    const body = JSON.parse(doctor.stdout) as {
      checks: Array<{ id: string; status: string; severity: string }>;
    };
    assert.equal(body.checks.find((check) => check.id === "api-health")?.status, "pass");
    assert.equal(body.checks.find((check) => check.id === "tunnel")?.status, "fail");
    assert.equal(body.checks.find((check) => check.id === "tunnel")?.severity, "warning");
    assert.equal(body.checks.find((check) => check.id === "process")?.status, "pass");
    run(["stop"], env);
  });

  it("resets the host password, invalidates old sessions, and hides the secret", async () => {
    const env = isolated();
    const setup = run(
      [
        "setup",
        "--non-interactive",
        "--display-name",
        "Ada Lovelace",
        "--projects-dir",
        env.OPENLEAF_PROJECTS_ROOT!,
        "--access",
        "remote",
        "--host-username",
        "ada-host",
        "--skip-build",
        "--skip-start",
        "--skip-compile",
      ],
      env,
    );
    assert.equal(setup.status, 0, setup.stderr + setup.stdout);
    const previousConfig = process.env.OPENLEAF_CONFIG_DIR;
    const previousAuth = process.env.OPENLEAF_HOST_AUTH_DIR;
    process.env.OPENLEAF_CONFIG_DIR = env.OPENLEAF_CONFIG_DIR;
    process.env.OPENLEAF_HOST_AUTH_DIR = env.OPENLEAF_CONFIG_DIR;
    try {
      const auth = await import("../../server/src/services/hostAuth.js");
      auth.resetHostAuthCache();
      const minted = auth.mintHostToken("ada-host");
      assert.ok(auth.verifyHostToken(minted));
      const reset = run(["account", "reset-password", "--generate"], env);
      assert.equal(reset.status, 0, reset.stderr + reset.stdout);
      const creds = fs.readFileSync(path.join(env.OPENLEAF_CONFIG_DIR!, "host-credentials.txt"), "utf8");
      const password = creds.match(/^Password:\s*(.+)$/m)?.[1]?.trim() ?? "";
      assert.ok(password.length >= 8);
      assert.doesNotMatch(reset.stdout + reset.stderr, new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      auth.resetHostAuthCache();
      assert.equal(auth.verifyHostToken(minted), null);
      const login = auth.hostLogin({ username: "ada-host", password }, "127.0.0.1");
      assert.equal(login.username, "ada-host");
      assert.throws(() => auth.hostLogin({ username: "ada-host", password: "wrong-password" }, "127.0.0.1"));
    } finally {
      if (previousConfig === undefined) delete process.env.OPENLEAF_CONFIG_DIR;
      else process.env.OPENLEAF_CONFIG_DIR = previousConfig;
      if (previousAuth === undefined) delete process.env.OPENLEAF_HOST_AUTH_DIR;
      else process.env.OPENLEAF_HOST_AUTH_DIR = previousAuth;
    }
  });

  it("strips host, guest, and AI secrets from a support report", () => {
    const hostPassword = "abcdefgh-ijklmnop-qrstuv";
    const guestPassword = "N7$kP2wQ4mX8!cR";
    const aiToken = crypto.randomBytes(24).toString("base64url");
    const libraryToken = crypto.randomBytes(18).toString("base64url");
    const cookie = `v1.${crypto.randomBytes(24).toString("base64url")}.sig`;
    const sample = [
      `Password: ${hostPassword}`,
      `guest password ${guestPassword}`,
      `Authorization: Bearer ${aiToken}`,
      `https://example.trycloudflare.com/library-ai/${libraryToken}`,
      `https://example.trycloudflare.com/join/vega-callisto-418`,
      `openleaf_host=${cookie}`,
      "OPENLEAF_HOST_TUNNEL_TOKEN=named-tunnel-token-value-123456",
      "manuscript /home/yinzh/papers/secret/main.tex",
    ].join("\n");
    const cleaned = redactText(sample);
    for (const secret of [hostPassword, guestPassword, aiToken, libraryToken, cookie, "named-tunnel-token-value-123456", "/home/yinzh/papers/secret/main.tex"]) {
      assert.equal(cleaned.includes(secret), false, secret);
    }

    const env = isolated();
    fs.mkdirSync(path.join(env.OPENLEAF_CONFIG_DIR!, "runtime"), { recursive: true });
    fs.writeFileSync(path.join(env.OPENLEAF_CONFIG_DIR!, "runtime", "openleaf.log"), `${sample}\n`);
    fs.writeFileSync(
      path.join(env.OPENLEAF_CONFIG_DIR!, "local.json"),
      `${JSON.stringify({ user: { displayName: "Ada Lovelace" } })}\n`,
    );
    const report = run(["support-report", "--json"], env);
    const parsed = JSON.parse(report.stdout) as { schemaVersion: number; prompt: string; logExcerpt: string };
    assert.equal(parsed.schemaVersion, 1);
    const blob = `${parsed.prompt}\n${parsed.logExcerpt}`;
    for (const secret of [hostPassword, guestPassword, aiToken, libraryToken, cookie, "vega-callisto-418"]) {
      assert.equal(blob.includes(secret), false, secret);
    }
    assert.match(parsed.prompt, /sanitized support report/);
  });

  it("compiles the sample when a TeX engine is installed", () => {
    const engine = spawnSync("which", ["pdflatex"], { encoding: "utf8" });
    if (engine.status !== 0) {
      console.log("skipped sample compile: pdflatex is not installed");
      return;
    }
    const env = isolated();
    const result = run(
      [
        "setup",
        "--non-interactive",
        "--display-name",
        "Ada Lovelace",
        "--projects-dir",
        env.OPENLEAF_PROJECTS_ROOT!,
        "--access",
        "localhost",
        "--skip-build",
        "--skip-start",
      ],
      { ...env, PATH: `/usr/bin:${process.env.PATH ?? ""}` },
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /Compiled openleaf-welcome/);
    assert.equal(
      fs.existsSync(path.join(env.OPENLEAF_PROJECTS_ROOT!, "openleaf-welcome", ".openleaf", "out", "main.pdf")),
      true,
    );
  });

  it("explains a missing production build instead of launching a broken server", () => {
    const root = temp("openleaf-nobuild-");
    const env: Record<string, string | undefined> = {
      ...isolated(22000 + Math.floor(Math.random() * 500)),
      OPENLEAF_REPO_ROOT: root,
      OPENLEAF_SERVER_ENTRY: undefined,
    };
    const result = run(["start"], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /npm run build/);
  });
});
