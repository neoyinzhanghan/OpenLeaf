import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfigDir, getLibraryRootAbs, getProjectsRootAbs, loadConfig, tryParseAppConfig } from "../../server/src/config.js";
import { compileProjectAtRoot } from "../../server/src/services/compiler.js";
import { commandExists, installHint, nodeMajor, type ToolId } from "./deps.js";
import {
  belongsToThisInstall,
  clientIndex,
  editorUrl,
  healthOk,
  portAccepting,
  processAlive,
  readInstance,
  serverEntry,
} from "./instance.js";

export const CHECK_SCHEMA_VERSION = 1;

export type CheckStatus = "pass" | "fail" | "skip";
export type Severity = "error" | "warning" | "info";

export type CheckResult = {
  id: string;
  severity: Severity;
  status: CheckStatus;
  summary: string;
  impact: string;
  action: string;
};

function pass(id: string, summary: string, impact = "No action needed.", severity: Severity = "info"): CheckResult {
  return { id, severity, status: "pass", summary, impact, action: "" };
}

function fail(
  id: string,
  severity: Severity,
  summary: string,
  impact: string,
  action: string,
): CheckResult {
  return { id, severity, status: "fail", summary, impact, action };
}

function skip(id: string, summary: string): CheckResult {
  return { id, severity: "info", status: "skip", summary, impact: "Not applicable to this install.", action: "" };
}

function writableDir(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function toolCheck(
  id: string,
  bin: string,
  tool: ToolId,
  required: boolean,
  impact: string,
): Promise<CheckResult> {
  const ok = await commandExists(bin);
  if (ok) return pass(id, `${bin} is available.`);
  if (!required) {
    return fail(id, "warning", `${bin} was not found.`, impact, installHint(tool));
  }
  return fail(id, "error", `${bin} was not found.`, impact, installHint(tool));
}

function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = out[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current &&
      typeof current === "object" &&
      !Array.isArray(current)
    ) {
      out[key] = deepMerge(current as Record<string, unknown>, value as Record<string, unknown>);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export async function runChecks(opts: { smoke?: boolean } = {}): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const configDir = getConfigDir();
  const defaultFile = path.join(configDir, "default.json");
  const localFile = path.join(configDir, "local.json");

  let parsedOk = false;
  try {
    if (fs.existsSync(defaultFile)) JSON.parse(fs.readFileSync(defaultFile, "utf8"));
    const localRaw = fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile, "utf8")) : {};
    const defaults = fs.existsSync(defaultFile) ? (JSON.parse(fs.readFileSync(defaultFile, "utf8")) as Record<string, unknown>) : {};
    const local =
      localRaw && typeof localRaw === "object" && !Array.isArray(localRaw) ? (localRaw as Record<string, unknown>) : {};
    const merged = deepMerge(defaults, local);
    const result = tryParseAppConfig(merged);
    if (!result.ok) {
      checks.push(
        fail(
          "config-parse",
          "error",
          `Configuration is invalid: ${result.message}`,
          "OpenLeaf cannot start until config/local.json parses.",
          "Fix the reported field in config/local.json, or move that file aside and run openleaf setup.",
        ),
      );
    } else {
      parsedOk = true;
      loadConfig(true);
      checks.push(pass("config-parse", "Configuration files parse."));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    checks.push(
      fail(
        "config-parse",
        "error",
        `Configuration could not be read: ${message}`,
        "OpenLeaf cannot load settings.",
        "Restore config/local.json to valid JSON. A backup may sit beside it as local.json.bak-*.",
      ),
    );
  }

  if (parsedOk) {
    const effective = loadConfig(true);
    const overrides: string[] = [];
    for (const key of [
      "OPENLEAF_HOST",
      "OPENLEAF_PORT",
      "OPENLEAF_PROJECTS_ROOT",
      "OPENLEAF_LIBRARY_ROOT",
      "OPENLEAF_ENGINE",
      "OPENLEAF_DISPLAY_NAME",
      "OPENLEAF_HOST_USER",
      "OPENLEAF_HOST_GATEWAY",
    ]) {
      if (process.env[key]) overrides.push(key);
    }
    checks.push(
      pass(
        "config-effective",
        `Effective bind ${effective.host}:${effective.port}, access ${effective.access ?? "unset"}.${overrides.length ? ` Environment overrides: ${overrides.join(", ")}.` : " No environment overrides."}`,
        "Environment variables win over config/local.json for the listed keys.",
      ),
    );
  } else {
    checks.push(skip("config-effective", "Skipped because configuration did not parse."));
    return checks;
  }

  const projects = getProjectsRootAbs();
  if (!fs.existsSync(projects)) {
    checks.push(
      fail(
        "projects-dir",
        "error",
        "The projects directory does not exist.",
        "New and existing papers cannot be opened.",
        "Run openleaf doctor --fix, or create the directory configured as projectsRoot.",
      ),
    );
  } else if (!writableDir(projects)) {
    checks.push(
      fail(
        "projects-dir",
        "error",
        "The projects directory is not writable.",
        "Saves and compiles will fail.",
        "Adjust permissions on the projects directory, or point projectsRoot at a directory you own.",
      ),
    );
  } else {
    checks.push(pass("projects-dir", "The projects directory exists and is writable."));
  }

  const library = getLibraryRootAbs();
  if (!fs.existsSync(library)) {
    checks.push(
      fail(
        "library-dir",
        "warning",
        "The citation library directory does not exist yet.",
        "The library is created on server start. This is expected before the first launch.",
        "Run openleaf start. The server creates the library directory.",
      ),
    );
  } else {
    checks.push(pass("library-dir", "The citation library directory exists."));
  }

  if (nodeMajor() < 20) {
    checks.push(
      fail(
        "node-version",
        "error",
        `Node ${process.version} is older than 20.`,
        "OpenLeaf will not run reliably.",
        "Install Node.js 20 or newer from https://nodejs.org/",
      ),
    );
  } else {
    checks.push(pass("node-version", `Node ${process.version} meets the requirement.`));
  }

  const engine = (loadConfig().latex.engine ?? "pdflatex") as ToolId;
  checks.push(await toolCheck("git", "git", "git", false, "Per-project history stays disabled until Git is installed."));
  checks.push(
    await toolCheck(
      "tex-engine",
      engine,
      engine,
      true,
      "Documents cannot compile until the configured TeX engine is installed.",
    ),
  );
  checks.push(
    await toolCheck("bibtex", "bibtex", "bibtex", true, "Bibliographies cannot be built until bibtex is installed."),
  );
  checks.push(
    await toolCheck(
      "latexmk",
      "latexmk",
      "latexmk",
      false,
      "Compiles still work via the engine plus bibtex. latexmk is the preferred driver.",
    ),
  );
  checks.push(
    await toolCheck(
      "latexdiff",
      "latexdiff",
      "latexdiff",
      false,
      "Track-changes PDFs and Markup PDF stay unavailable.",
    ),
  );

  const access = loadConfig().access;
  const cloudflared = await commandExists("cloudflared");
  if (access === "remote") {
    checks.push(
      cloudflared
        ? pass("cloudflared", "cloudflared is available for the public link.")
        : fail(
            "cloudflared",
            "warning",
            "cloudflared was not found.",
            "The public link stays down. The editor on localhost still works.",
            installHint("cloudflared"),
          ),
    );
  } else if (cloudflared) {
    checks.push(pass("cloudflared", "cloudflared is installed. Public links stay off unless access is remote."));
  } else {
    checks.push(skip("cloudflared", "cloudflared is optional because this install is not set to remote access."));
  }

  const serverBuilt = fs.existsSync(serverEntry()) || Boolean(process.env.OPENLEAF_SERVER_ENTRY);
  const clientBuilt = fs.existsSync(clientIndex()) || Boolean(process.env.OPENLEAF_SERVER_ENTRY);
  checks.push(
    serverBuilt
      ? pass("server-build", "The server production build is present.")
      : fail(
          "server-build",
          "warning",
          "server/dist is missing.",
          "openleaf start cannot launch the app. Contributors can still use npm run dev.",
          "From the repository root run: npm run build",
        ),
  );
  checks.push(
    clientBuilt
      ? pass("client-build", "The editor production build is present.")
      : fail(
          "client-build",
          "warning",
          "client/dist is missing.",
          "openleaf start cannot serve the editor page. Contributors can still use npm run dev.",
          "From the repository root run: npm run build",
        ),
  );

  const meta = readInstance();
  if (!meta) {
    checks.push(
      fail(
        "process",
        "warning",
        "No OpenLeaf process is recorded for this install.",
        "The editor is not running.",
        "Run openleaf start",
      ),
    );
  } else if (!processAlive(meta.pid)) {
    checks.push(
      fail(
        "process",
        "warning",
        "Instance metadata points at a process that is not running.",
        "Start will treat this as stale metadata.",
        "Run openleaf doctor --fix, then openleaf start",
      ),
    );
  } else if (!belongsToThisInstall(meta.pid)) {
    checks.push(
      fail(
        "process",
        "error",
        "Instance metadata names a live process that is not this OpenLeaf install.",
        "openleaf stop will refuse to kill it.",
        "Run openleaf doctor --fix to drop the stale metadata if you are sure it is leftover. OpenLeaf will not kill that process.",
      ),
    );
  } else {
    checks.push(pass("process", `OpenLeaf is running (pid ${meta.pid}).`));
  }

  const cfg = loadConfig();
  const listening = await portAccepting(cfg.port, cfg.host);
  const ours = meta && processAlive(meta.pid) && belongsToThisInstall(meta.pid);
  if (listening && ours) {
    checks.push(pass("port", `Port ${cfg.port} is serving this OpenLeaf install.`));
  } else if (listening && !ours) {
    checks.push(
      fail(
        "port",
        "error",
        `Port ${cfg.port} is in use by something that is not this OpenLeaf install.`,
        "openleaf start will not take the port, and it will not kill the other process.",
        "Choose another port in config/local.json or set OPENLEAF_PORT, then run openleaf start.",
      ),
    );
  } else {
    checks.push(pass("port", `Port ${cfg.port} is free.`));
  }

  const healthy = await healthOk(cfg.port, cfg.host);
  if (healthy) {
    checks.push(pass("api-health", `API health check succeeded at ${editorUrl()}.`));
    checks.push(
      clientBuilt
        ? pass("app-ready", `The editor should be reachable at ${editorUrl()}.`)
        : fail(
            "app-ready",
            "warning",
            "The API answered, but the editor bundle is not built.",
            "Opening the URL will not show the editor.",
            "Run npm run build, then openleaf restart",
          ),
    );
  } else if (ours) {
    checks.push(
      fail(
        "api-health",
        "error",
        "The recorded process is alive but /api/health did not succeed.",
        "The editor is not usable yet.",
        "Run openleaf logs, then openleaf restart",
      ),
    );
    checks.push(skip("app-ready", "Skipped because the API health check failed."));
  } else {
    checks.push(
      fail(
        "api-health",
        "warning",
        "The API is not answering.",
        "The editor is stopped or still starting.",
        "Run openleaf start",
      ),
    );
    checks.push(skip("app-ready", "Skipped because the API is not answering."));
  }

  const gatewayFile = path.join(configDir, "host-gateway.json");
  if (access !== "remote") {
    checks.push(
      skip("tunnel", "Public sharing is not enabled for this install. Localhost health is independent of any tunnel."),
    );
  } else if (!fs.existsSync(gatewayFile)) {
    checks.push(
      fail(
        "tunnel",
        "warning",
        "No public-link status file is present.",
        "The public link is not up. Localhost is unaffected.",
        "Install cloudflared if needed, then run openleaf restart",
      ),
    );
  } else {
    try {
      const gateway = JSON.parse(fs.readFileSync(gatewayFile, "utf8")) as {
        status?: string;
        localOnly?: boolean;
        dnsReady?: boolean;
      };
      if (gateway.localOnly || gateway.status === "error" || gateway.status === "stopped") {
        checks.push(
          fail(
            "tunnel",
            "warning",
            `The public link is ${gateway.status ?? "unavailable"}.`,
            "Remote guests cannot open the public URL. The local editor is a separate check.",
            "Run openleaf logs and confirm cloudflared is installed, then openleaf restart",
          ),
        );
      } else if (gateway.dnsReady === false) {
        checks.push(
          fail(
            "tunnel",
            "warning",
            "The tunnel is up but public DNS is not ready yet.",
            "Guests may see a name-resolution error for a minute. Localhost still works.",
            "Wait and retry the public URL. Run openleaf doctor again to recheck.",
          ),
        );
      } else {
        checks.push(pass("tunnel", "The public link reports an active tunnel."));
      }
    } catch {
      checks.push(
        fail(
          "tunnel",
          "warning",
          "The public-link status file could not be read.",
          "Remote sharing status is unknown. Localhost is unaffected.",
          "Run openleaf restart to rewrite tunnel status.",
        ),
      );
    }
  }

  if (!opts.smoke) {
    checks.push(skip("tex-smoke", "TeX smoke compile was not requested. Re-run with openleaf doctor --smoke."));
  } else if (!(await commandExists(engine))) {
    checks.push(
      fail(
        "tex-smoke",
        "error",
        "Skipped the smoke compile because the TeX engine is missing.",
        "Setup cannot finish a sample PDF.",
        installHint(engine),
      ),
    );
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-smoke-"));
    try {
      fs.writeFileSync(
        path.join(dir, "main.tex"),
        "\\documentclass{article}\n\\begin{document}\nOpenLeaf smoke test.\n\\end{document}\n",
      );
      fs.writeFileSync(path.join(dir, "openleaf.json"), `${JSON.stringify({ mainFile: "main.tex" })}\n`);
      const result = await compileProjectAtRoot("openleaf-smoke", undefined, dir);
      if (result.ok) checks.push(pass("tex-smoke", "A temporary document compiled to PDF."));
      else {
        checks.push(
          fail(
            "tex-smoke",
            "error",
            "The temporary document did not produce a PDF.",
            "Real papers will fail the same way until the TeX error is resolved.",
            "Run openleaf doctor --smoke again after installing the missing TeX packages. The compiler log was not saved into your papers.",
          ),
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  return checks;
}

export function hasErrors(checks: CheckResult[]): boolean {
  return checks.some((check) => check.status === "fail" && check.severity === "error");
}

export function backupConfigFile(): string | null {
  const localFile = path.join(getConfigDir(), "local.json");
  if (!fs.existsSync(localFile)) return null;
  const dest = path.join(getConfigDir(), `local.json.bak-${Date.now()}`);
  fs.copyFileSync(localFile, dest);
  return dest;
}

export type FixReport = {
  applied: string[];
  skipped: string[];
};

/**
 * Bounded repairs: create the configured projects directory when its parent
 * exists, and delete instance metadata whose pid is not alive.
 * Never deletes papers, resets accounts, or rewrites config.
 */
export function applySafeFixes(opts: { yes: boolean; interactive: boolean }): FixReport {
  const applied: string[] = [];
  const skipped: string[] = [];
  const projects = getProjectsRootAbs();
  if (!fs.existsSync(projects)) {
    const parent = path.dirname(projects);
    if (fs.existsSync(parent) && writableDir(parent)) {
      fs.mkdirSync(projects, { recursive: false });
      applied.push("Created the missing projects directory.");
    } else if (!opts.yes) {
      skipped.push(
        opts.interactive
          ? "The projects directory parent is missing. Re-run with --yes to create it, or change projectsRoot."
          : "Refusing to create a missing projects parent without --yes.",
      );
    } else {
      fs.mkdirSync(projects, { recursive: true });
      applied.push("Created the projects directory, including missing parents.");
    }
  }

  const meta = readInstance();
  if (meta && !processAlive(meta.pid)) {
    fs.rmSync(path.join(getConfigDir(), "runtime", "instance.json"), { force: true });
    applied.push("Removed stale instance metadata for a process that is not running.");
  } else if (meta && processAlive(meta.pid) && !belongsToThisInstall(meta.pid)) {
    if (!opts.yes) {
      skipped.push(
        "Instance metadata points at a live process that is not this install. Re-run with --yes to drop the metadata. The process will not be killed.",
      );
    } else {
      fs.rmSync(path.join(getConfigDir(), "runtime", "instance.json"), { force: true });
      applied.push("Removed instance metadata. The unrelated process was left running.");
    }
  }

  if (applied.length === 0 && skipped.length === 0) {
    skipped.push("Nothing safe to repair.");
  }
  return { applied, skipped };
}
