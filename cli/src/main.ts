import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { flagBool, flagString, parseArgs } from "./args.js";
import { applySafeFixes, CHECK_SCHEMA_VERSION, hasErrors, runChecks } from "./checks.js";
import { commandExists, installHint, nodeMajor } from "./deps.js";
import { editorUrl, logPath, openEditor, readInstance, startServer, stopServer, tailLog } from "./instance.js";
import { CliError, emitJson, fail, isJsonMode, out, setJsonMode } from "./output.js";
import { isInteractive, promptLine, promptSecret, readStdin } from "./prompts.js";
import { buildSupportReport, formatSupportReport } from "./sanitize.js";
import { runSetup } from "./setup.js";
import { getConfigDir, getProjectsRootAbs, loadConfig, REPO_ROOT, type AccessMode } from "../../server/src/config.js";
import {
  ensureHostAuth,
  generateHostPassword,
  loadHostAuth,
  resetHostAuthCache,
  resetHostPassword,
} from "../../server/src/services/hostAuth.js";

const HELP = `OpenLeaf commands

  openleaf
      Show the editor URL and whether it is running.
      In a terminal, you can then type an action.

  openleaf help
      Show this list. openleaf --help and openleaf -h do the same thing.

  openleaf setup
      First-time setup: your display name, where papers are stored, and who
      can open the editor. It then builds the app, starts it, and compiles
      a sample. Papers and logins already on disk are kept.

  openleaf start
      Start the editor and wait until it answers. This serves the built app.

  openleaf stop
      Stop the editor this command started. A server started another way,
      such as the system service, is left running.

  openleaf restart
      Stop, then start.

  openleaf status
      Print the editor URL, the process, and whether the API is healthy.

  openleaf open
      Open the editor URL in your browser.

  openleaf logs
      Print the server log. --follow keeps printing new lines.
      --lines N sets how many existing lines to show first (default 80).

  openleaf doctor
      Check Node, TeX, config, and the build. Nothing is changed.
      --fix creates a missing projects folder or clears a dead process record.
      --smoke compiles a throwaway file and leaves your papers alone.
      --json prints the same checks as JSON.

  openleaf support-report
      Write a report with secrets removed, for pasting into an assistant.
      It is not uploaded. --out FILE writes it to a file. --json prints JSON.

  openleaf account reset-password
      Set a new host password and sign out phones and other devices.
      The computer itself stays signed in. Other devices use that password.
      --generate writes a new password into the credentials file.
      --password-stdin reads the new password from stdin.
      The password is never accepted as a command-line argument.

  openleaf install-cli
      Put the openleaf command on PATH for this checkout.
      --force replaces a command that already points at another checkout.
      --add-to-path writes a PATH line into the shell startup file.
      npm ci does not edit shell startup files and does not replace another checkout.

  openleaf uninstall-cli
      Remove the openleaf command if it points at this checkout.

Setup flags:
  --display-name NAME
  --projects-dir PATH
  --access localhost|lan|remote
  --library-dir PATH           Citation library (default: a library folder next to the projects folder)
  --host-username NAME
  --password-stdin
  --non-interactive
  --yes
  --skip-build --skip-start --skip-compile --skip-open

Exit codes: 0 success, 1 failure, 2 usage or missing confirmation, 3 setup incomplete.
npm ci installs this command onto PATH. From inside the checkout,
node cli/bin/openleaf.js is the same program.
Contributors run the live editor with: npm run dev
`;

function runInstaller(args: string[]): number {
  const script = path.join(REPO_ROOT, "scripts", "install-cli-bin.mjs");
  const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });
  return result.status ?? 1;
}

function nonInteractive(flags: Map<string, string | true>): boolean {
  return flagBool(flags, "non-interactive") || !isInteractive();
}

function printChecks(checks: Awaited<ReturnType<typeof runChecks>>): void {
  for (const check of checks) {
    const mark = check.status === "pass" ? "ok" : check.status === "skip" ? "skip" : check.severity;
    out(`${mark.padEnd(7)} ${check.id}: ${check.summary}`);
    if (check.status === "fail") {
      out(`        Impact: ${check.impact}`);
      if (check.action) out(`        Next: ${check.action}`);
    }
  }
}

async function dispatch(positionals: string[], flags: Map<string, string | true>): Promise<number> {
  const [command, sub] = positionals;
  if (!command || command === "help") {
    out(HELP);
    return 0;
  }
  if (command === "setup") return cmdSetup(flags);
  if (command === "start") return cmdStart();
  if (command === "stop") return cmdStop();
  if (command === "restart") return cmdRestart();
  if (command === "status") return cmdStatus();
  if (command === "open") return cmdOpen();
  if (command === "logs") return cmdLogs(flags);
  if (command === "doctor") return cmdDoctor(flags);
  if (command === "support-report") return cmdSupport(flags);
  if (command === "account" && sub === "reset-password") return cmdReset(flags);
  if (command === "install-cli") {
    const args = [
      ...(flagBool(flags, "force") ? ["--force"] : []),
      ...(flagBool(flags, "add-to-path") ? ["--add-to-path"] : []),
    ];
    return runInstaller(args);
  }
  if (command === "uninstall-cli") return runInstaller(["--uninstall"]);
  throw new CliError(`Unknown command.\n${HELP}`, 2);
}

async function showMenu(): Promise<number> {
  const cfg = loadConfig(true);
  const meta = readInstance();
  out("OpenLeaf");
  out(`Projects: ${getProjectsRootAbs()}`);
  out(`Editor:   ${editorUrl(cfg.host, cfg.port)}`);
  out(meta ? `Process:  pid ${meta.pid}` : "Process:  not started");
  out("");
  out("Commands: setup, start, stop, restart, status, open, logs, doctor, support-report, help");
  out("Password: openleaf account reset-password");
  if (!isInteractive()) {
    out("Run openleaf help for what each command does. This shell is not interactive, so no menu was opened.");
    return 0;
  }
  const choice = (await promptLine("Action (or press Enter to quit)")).toLowerCase();
  if (!choice) return 0;
  return dispatch(choice.split(/\s+/), new Map());
}

async function cmdSetup(flags: Map<string, string | true>): Promise<number> {
  const auto = nonInteractive(flags);
  const configDir = getConfigDir();
  const existing =
    fs.existsSync(path.join(configDir, "local.json")) || fs.existsSync(path.join(configDir, "host-auth.json"));
  if (existing) out("Existing installation detected. Current projects and logins are kept unless you pass new values.");
  if (nodeMajor() < 20) throw new CliError("Node.js 20 or newer is required. https://nodejs.org/", 1);

  if (!(await commandExists("pdflatex"))) {
    out("pdflatex was not found. Configuration can still be saved, but the sample PDF cannot be built yet.");
    out(installHint("pdflatex"));
  }
  if (!(await commandExists("git"))) {
    out("Git was not found. Per-project history stays unavailable until it is installed.");
    out(installHint("git"));
  }
  if (!(await commandExists("latexmk"))) out("latexmk is optional. Compiles fall back to the TeX engine.");
  if (!(await commandExists("cloudflared"))) out("cloudflared is optional. Public links need it; localhost does not.");

  let displayName = flagString(flags, "display-name");
  let updateIdentity = Boolean(displayName);
  const currentName = loadConfig(true).user.displayName;
  if (!displayName && currentName) displayName = currentName;
  if (!displayName) {
    if (auto) throw new CliError('A display name is required. Re-run with --display-name "Your Name".', 2);
    displayName = await promptLine("Your display name (collaboration only, not the host login)");
    if (!displayName) throw new CliError("A display name is required.", 2);
    updateIdentity = true;
  }

  let projectsDir = flagString(flags, "projects-dir");
  const libraryDir = flagString(flags, "library-dir");
  if (!projectsDir && !existing) {
    const suggested = path.join(os.homedir(), "OpenLeaf", "projects");
    if (auto) projectsDir = suggested;
    else projectsDir = (await promptLine("Projects directory", suggested)) || suggested;
  }

  let access = flagString(flags, "access") as AccessMode | undefined;
  if (access && !["localhost", "lan", "remote"].includes(access)) {
    throw new CliError("--access must be localhost, lan, or remote.", 2);
  }
  if (!access && !existing) {
    if (auto) access = "localhost";
    else {
      out("localhost — only this computer.");
      out("lan — other devices on your Wi-Fi. Each phone is paired from Open on your phone.");
      out("remote — a public link. You sign in with the host password.");
      const answer = ((await promptLine("Access: localhost, lan, or remote", "localhost")) || "localhost").toLowerCase();
      if (!["localhost", "lan", "remote"].includes(answer)) throw new CliError("Access must be localhost, lan, or remote.", 2);
      access = answer as AccessMode;
    }
  }

  let hostUsername = flagString(flags, "host-username");
  let hostPassword: string | undefined;
  if (access === "remote") {
    if (!hostUsername) {
      hostUsername = auto ? loadConfig().user.hostUsername || "host" : (await promptLine("Host login username", "host")) || "host";
    }
    if (flagBool(flags, "password-stdin")) hostPassword = await readStdin();
    else if (!loadHostAuth()) {
      if (auto) hostPassword = generateHostPassword();
      else {
        const entered = await promptSecret("Host password (empty to generate one)");
        hostPassword = entered || generateHostPassword();
      }
      out("A host password will be stored in the credentials file and will not be printed.");
    }
  }

  const result = await runSetup(
    {
      displayName,
      updateIdentity,
      projectsDir,
      libraryDir,
      access,
      hostUsername,
      hostPassword,
      existing,
      skipBuild: flagBool(flags, "skip-build"),
      skipStart: flagBool(flags, "skip-start"),
      skipCompile: flagBool(flags, "skip-compile"),
      skipOpen: flagBool(flags, "skip-open") || auto,
    },
    REPO_ROOT,
  );
  for (const note of result.notes) out(note);
  if (!result.complete) {
    out("Setup is incomplete.");
    for (const step of result.next) out(`Next: ${step}`);
    return 3;
  }
  out("Setup is complete.");
  for (const step of result.next) out(`Next: ${step}`);
  return 0;
}

async function cmdStart(): Promise<number> {
  const result = await startServer();
  if (result.status === "failed") throw new CliError(result.message, 1);
  out(result.status === "already-running" ? `Already running at ${result.url}` : `Ready at ${result.url}`);
  return 0;
}

async function cmdStop(): Promise<number> {
  const result = await stopServer();
  out(result.message);
  return result.stopped || result.message.includes("not running") ? 0 : 1;
}

async function cmdRestart(): Promise<number> {
  const stopped = await stopServer();
  out(stopped.message);
  if (!stopped.stopped && !stopped.message.includes("not running") && !stopped.message.includes("already gone")) {
    return 1;
  }
  return cmdStart();
}

const STATUS_CHECK_IDS = ["process", "port", "api-health", "app-ready", "tunnel"];

async function cmdStatus(): Promise<number> {
  const checks = await runChecks({ smoke: false });
  const shown = checks.filter((check) => STATUS_CHECK_IDS.includes(check.id));
  if (isJsonMode()) {
    emitJson({ schemaVersion: CHECK_SCHEMA_VERSION, url: editorUrl(), checks: shown });
  } else {
    out(`Editor: ${editorUrl()}`);
    printChecks(shown);
  }
  // Missing TeX is a doctor error. Status only reports whether this install is up.
  return hasErrors(shown) ? 1 : 0;
}

async function cmdOpen(): Promise<number> {
  const meta = readInstance();
  out(openEditor(editorUrl(meta?.host, meta?.port)).message);
  return 0;
}

async function cmdLogs(flags: Map<string, string | true>): Promise<number> {
  const lines = Number(flagString(flags, "lines") ?? "80");
  const text = tailLog(Number.isFinite(lines) ? lines : 80);
  if (!text) out(`No log yet. Start the app with openleaf start. Log file: ${logPath()}`);
  else process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  if (!flagBool(flags, "follow")) return 0;
  let pos = 0;
  try {
    pos = fs.statSync(logPath()).size;
  } catch {
    pos = 0;
  }
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (!fs.existsSync(logPath())) return;
      const size = fs.statSync(logPath()).size;
      if (size < pos) pos = 0;
      if (size <= pos) return;
      const fd = fs.openSync(logPath(), "r");
      const buf = Buffer.alloc(size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      process.stdout.write(buf);
      pos = size;
    }, 400);
    const stop = () => {
      clearInterval(timer);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

async function cmdDoctor(flags: Map<string, string | true>): Promise<number> {
  const smoke = flagBool(flags, "smoke");
  if (flagBool(flags, "fix")) {
    const fixes = applySafeFixes({
      yes: flagBool(flags, "yes"),
      interactive: isInteractive() && !flagBool(flags, "non-interactive"),
    });
    const checks = await runChecks({ smoke });
    if (isJsonMode()) emitJson({ schemaVersion: CHECK_SCHEMA_VERSION, checks, fixes });
    else {
      for (const line of fixes.applied) out(`Fixed: ${line}`);
      for (const line of fixes.skipped) out(line);
      printChecks(checks);
    }
    if (fixes.skipped.some((line) => line.includes("--yes")) && !flagBool(flags, "yes")) return 2;
    return hasErrors(checks) ? 1 : 0;
  }
  const checks = await runChecks({ smoke });
  if (isJsonMode()) emitJson({ schemaVersion: CHECK_SCHEMA_VERSION, checks });
  else printChecks(checks);
  return hasErrors(checks) ? 1 : 0;
}

async function cmdSupport(flags: Map<string, string | true>): Promise<number> {
  const report = buildSupportReport(await runChecks({ smoke: false }));
  const outPath = flagString(flags, "out");
  const body = isJsonMode() ? `${JSON.stringify(report, null, 2)}\n` : `${formatSupportReport(report)}\n`;
  if (outPath) {
    fs.writeFileSync(outPath, body, { encoding: "utf8", mode: 0o600 });
    if (isJsonMode()) emitJson({ ok: true, out: outPath, schemaVersion: report.schemaVersion });
    else out(`Wrote ${outPath}. Nothing was uploaded.`);
  } else if (isJsonMode()) emitJson(report);
  else process.stdout.write(body);
  return report.failingChecks.some((check) => check.status === "fail" && check.severity === "error") ? 1 : 0;
}

async function cmdReset(flags: Map<string, string | true>): Promise<number> {
  resetHostAuthCache();
  if (!loadHostAuth()) {
    ensureHostAuth();
    resetHostAuthCache();
  }
  let password: string;
  if (flagBool(flags, "generate")) password = generateHostPassword();
  else if (flagBool(flags, "password-stdin")) password = await readStdin();
  else if (nonInteractive(flags)) {
    throw new CliError(
      "Refusing to prompt without a terminal. Use --generate or --password-stdin. Do not pass the password as an argument.",
      2,
    );
  } else {
    password = await promptSecret("New host password");
    const again = await promptSecret("Repeat password");
    if (password !== again) throw new CliError("Passwords did not match.", 2);
  }
  const result = resetHostPassword(password);
  out(`Host password updated for ${result.username}. Existing host sessions are signed out.`);
  out("The new password is in the host credentials file. It was not written to the server log.");
  return 0;
}

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv);
  if (flagBool(flags, "version")) {
    out("openleaf 1.0.0");
    return;
  }
  if (flagBool(flags, "help") || positionals[0] === "-h") {
    out(HELP);
    return;
  }
  setJsonMode(flagBool(flags, "json"));
  if (flagBool(flags, "json") && positionals.length === 0) {
    throw new CliError("--json needs a command such as: openleaf doctor --json", 2);
  }
  const code = positionals.length === 0 ? await showMenu() : await dispatch(positionals, flags);
  process.exitCode = code;
}

main().catch((err: unknown) => {
  if (err instanceof CliError) fail(err.message, err.exitCode);
  fail(err instanceof Error ? err.message : String(err), 1);
});
