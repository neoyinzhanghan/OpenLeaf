import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  getProjectsRootAbs,
  identityFromDisplayName,
  loadConfig,
  patchConfig,
  type AccessMode,
} from "../../server/src/config.js";
import { compileProjectAtRoot } from "../../server/src/services/compiler.js";
import { ensureHostAuth, loadHostAuth, resetHostAuthCache } from "../../server/src/services/hostAuth.js";
import { commandExists } from "./deps.js";
import { editorUrl, openEditor, startServer } from "./instance.js";
import { npmBuildCommand } from "./platform.js";

const WELCOME_ID = "openleaf-welcome";

export type SetupRequest = {
  displayName?: string;
  /** When true, write displayName into the seed identity. Existing projects are not rewritten. */
  updateIdentity: boolean;
  projectsDir?: string;
  access?: AccessMode;
  hostUsername?: string;
  hostPassword?: string;
  existing: boolean;
  skipBuild: boolean;
  skipStart: boolean;
  skipCompile: boolean;
  skipOpen: boolean;
};

export type SetupResult = {
  complete: boolean;
  url?: string;
  projectsRoot: string;
  notes: string[];
  next: string[];
};

function runNpmBuild(repoRoot: string): Promise<void> {
  const npm = npmBuildCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(npm.command, npm.args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
      shell: npm.shell,
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm run build exited with ${code ?? "unknown"}`));
    });
  });
}

function ensureWelcome(displayName: string | undefined): { created: boolean; id: string } {
  const root = getProjectsRootAbs();
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, WELCOME_ID);
  if (fs.existsSync(dir)) return { created: false, id: WELCOME_ID };
  fs.mkdirSync(dir, { recursive: true });
  const identity = displayName ? identityFromDisplayName(displayName) : { id: "author", name: "Author", color: "#0F766E" };
  const tex = [
    "\\documentclass{article}",
    "\\begin{document}",
    `Hello. This sample was created by \\texttt{openleaf setup}.`,
    "\\end{document}",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "main.tex"), tex);
  fs.writeFileSync(
    path.join(dir, "openleaf.json"),
    `${JSON.stringify({ mainFile: "main.tex", identities: [identity] }, null, 2)}\n`,
  );
  return { created: true, id: WELCOME_ID };
}

export async function runSetup(request: SetupRequest, repoRoot: string): Promise<SetupResult> {
  const notes: string[] = [];
  const next: string[] = [];
  const patch: Record<string, unknown> = {};
  const user: Record<string, string> = {};

  if (request.updateIdentity && request.displayName) {
    user.displayName = request.displayName;
    patch.defaultIdentities = [identityFromDisplayName(request.displayName)];
    notes.push("New projects will use your display name. Existing project files were left unchanged.");
  }
  if (request.hostUsername) user.hostUsername = request.hostUsername;
  if (Object.keys(user).length) patch.user = user;

  if (request.projectsDir) patch.projectsRoot = request.projectsDir;
  if (request.access) {
    patch.access = request.access;
    if (request.access === "lan") patch.host = "0.0.0.0";
    else patch.host = "127.0.0.1";
  } else if (!request.existing) {
    patch.access = "localhost";
    patch.host = "127.0.0.1";
    notes.push("Bound to localhost only. Re-run openleaf setup to enable LAN or a public link.");
  }

  if (Object.keys(patch).length) patchConfig(patch);
  const cfg = loadConfig(true);

  if (cfg.access === "remote") {
    resetHostAuthCache();
    if (loadHostAuth()) {
      notes.push("Existing host login was kept. Use openleaf account reset-password to change it.");
    } else if (request.hostPassword) {
      process.env.OPENLEAF_HOST_PASSWORD = request.hostPassword;
      process.env.OPENLEAF_HOST_USER = cfg.user.hostUsername || request.hostUsername || "host";
      const created = ensureHostAuth();
      delete process.env.OPENLEAF_HOST_PASSWORD;
      resetHostAuthCache();
      notes.push(
        created.created
          ? `Host login username is ${created.username}. The password is in the host credentials file, not the log.`
          : "Host login already existed and was not reset.",
      );
    } else {
      next.push("Remote access still needs a host password. Run openleaf account reset-password --generate");
    }
  }

  const welcome = ensureWelcome(cfg.user.displayName);
  notes.push(
    welcome.created
      ? `Created sample project ${welcome.id}.`
      : `Sample project ${welcome.id} already exists and was not modified.`,
  );

  if (!request.skipBuild) {
    await runNpmBuild(repoRoot);
    notes.push("Built the editor and server.");
  }

  let serverOk = request.skipStart;
  let url: string | undefined;
  if (!request.skipStart) {
    const started = await startServer();
    if (started.status === "failed") {
      next.push(started.message);
      next.push("After that, run openleaf start");
      return { complete: false, projectsRoot: getProjectsRootAbs(), notes, next };
    }
    serverOk = true;
    url = started.url;
    notes.push(
      started.status === "already-running" ? `Already running at ${started.url}` : `Started at ${started.url}`,
    );
  } else {
    url = editorUrl();
  }

  let compiled = request.skipCompile;
  if (!request.skipCompile) {
    const engine = cfg.latex.engine;
    if (!(await commandExists(engine))) {
      next.push(`Install ${engine}, then run openleaf setup again to compile the sample.`);
    } else {
      const dir = path.join(getProjectsRootAbs(), WELCOME_ID);
      const result = await compileProjectAtRoot(WELCOME_ID, undefined, dir);
      compiled = result.ok;
      if (!result.ok) {
        next.push("The sample did not produce a PDF. Run openleaf doctor --smoke for a temporary compile check.");
      } else {
        notes.push(`Compiled ${WELCOME_ID} to PDF.`);
      }
    }
  }

  if (url && !request.skipOpen && compiled) {
    const opened = openEditor(url);
    notes.push(opened.message);
  }

  const features = [
    `access ${cfg.access ?? "unset"}`,
    `engine ${cfg.latex.engine}`,
    cfg.git.enabled ? "git history on" : "git history off",
  ];
  notes.push(`Features: ${features.join(", ")}.`);
  notes.push(`Projects: ${getProjectsRootAbs()}`);
  if (url) notes.push(`Editor: ${url}`);
  next.push("openleaf status", "openleaf doctor", "openleaf logs");

  return {
    complete: compiled && serverOk,
    url,
    projectsRoot: getProjectsRootAbs(),
    notes,
    next,
  };
}
