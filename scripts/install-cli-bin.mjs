#!/usr/bin/env node
/**
 * Put the `openleaf` command on PATH after `npm ci` / `npm install`.
 * Never fails the install: a checkout can still run `node cli/bin/openleaf.js`.
 *
 * Linux and macOS: symlink next to Node when that directory is writable
 * (nvm, Homebrew, fnm). Otherwise ~/.local/bin or ~/bin, and a shell startup
 * line when that directory is not already on PATH.
 * Windows: openleaf.cmd for Command Prompt and PowerShell, plus an extensionless
 * script for Git Bash, in %AppData%\npm (the directory the Node installer adds
 * to the user PATH).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(repoRoot, "cli", "bin", "openleaf.js");
const MARKER = "# openleaf-cli";

export function unique(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export function ignoredBinDir(dir) {
  const folded = dir.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  return (
    folded.includes("/.cursor-server/") ||
    folded.endsWith("/.cursor-server") ||
    folded.includes("/.cursor/") ||
    folded.endsWith("/.cursor")
  );
}

export function pathContains(pathEnv, dir, platform) {
  if (!pathEnv || !dir) return false;
  const sep = platform === "win32" ? ";" : ":";
  const fold = (value) => (platform === "win32" ? value.replace(/[\\/]+$/, "").toLowerCase() : value.replace(/\/+$/, ""));
  const want = fold(dir);
  return pathEnv.split(sep).some((part) => part && fold(part) === want);
}

export function binCandidates({ env, platform, execPath, homedir, nvmVersions }) {
  if (env.OPENLEAF_BIN_DIR?.trim()) return [path.resolve(env.OPENLEAF_BIN_DIR.trim())];
  const list = [];
  if (platform === "win32") {
    if (env.APPDATA) list.push(path.join(env.APPDATA, "npm"));
    if (env.npm_config_prefix) list.push(env.npm_config_prefix);
    if (execPath) list.push(path.dirname(execPath));
  } else {
    if (env.npm_config_prefix) list.push(path.join(env.npm_config_prefix, "bin"));
    if (execPath) list.push(path.dirname(execPath));
    if (nvmVersions) list.push(nvmVersions);
    if (platform === "darwin") {
      list.push("/opt/homebrew/bin", "/usr/local/bin");
    }
    list.push(path.join(homedir, ".local", "bin"));
    list.push(path.join(homedir, "bin"));
  }
  return unique(list).filter((dir) => !ignoredBinDir(dir));
}

export function chooseBinDir(candidates, pathEnv, platform, canWrite) {
  const writable = candidates.filter((dir) => canWrite(dir));
  return writable.find((dir) => pathContains(pathEnv, dir, platform)) ?? writable[0] ?? null;
}

function shellName(shell) {
  return (shell ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
}

export function shellStartupFile(platform, shell, homedir) {
  if (platform === "win32") return null;
  const name = shellName(shell);
  if (name.includes("fish")) return path.join(homedir, ".config", "fish", "config.fish");
  if (name.includes("zsh") || (platform === "darwin" && !name.includes("bash"))) {
    return path.join(homedir, ".zshrc");
  }
  return path.join(homedir, ".bashrc");
}

export function pathExportSnippet(binDir, homedir, fish) {
  const rel = path.relative(homedir, binDir);
  const portable = rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  const expr = portable ? `$HOME/${rel.split(path.sep).join("/")}` : binDir;
  if (fish) {
    return `${MARKER}\nif not contains ${expr} $PATH\n  set -gx PATH ${expr} $PATH\nend\n`;
  }
  return `${MARKER}\ncase ":$PATH:" in\n  *":${expr}:"*) ;;\n  *) PATH="${expr}:$PATH" ;;\nesac\n`;
}

export function windowsShimBodies(nodePath, scriptPath) {
  const cmd = `@ECHO off\r\n"${nodePath}" "${scriptPath}" %*\r\n`;
  const sh = `#!/bin/sh\nexec "${toMsysPath(nodePath)}" "${toMsysPath(scriptPath)}" "$@"\n`;
  return { cmd, sh };
}

export function toMsysPath(value) {
  const norm = value.replace(/\\/g, "/");
  const match = /^([A-Za-z]):\//.exec(norm);
  if (!match) return norm;
  return `/${match[1].toLowerCase()}${norm.slice(2)}`;
}

function nvmBinDir() {
  const root = process.env.NVM_DIR?.trim();
  if (!root) return null;
  const versionsDir = path.join(root, "versions", "node");
  let names = [];
  try {
    names = fs.readdirSync(versionsDir);
  } catch {
    return null;
  }
  names = names.filter((name) => fs.existsSync(path.join(versionsDir, name, "bin", "node")));
  if (names.length === 0) return null;
  let alias = "";
  try {
    alias = fs.readFileSync(path.join(root, "alias", "default"), "utf8").trim();
  } catch {
    alias = "";
  }
  const chosen = names.includes(alias)
    ? alias
    : names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  return chosen ? path.join(versionsDir, chosen, "bin") : null;
}

function writable(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    }
    fs.accessSync(path.dirname(dir), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function linkTarget(linkPath) {
  try {
    return fs.readlinkSync(linkPath);
  } catch {
    return null;
  }
}

function installUnix(dir, force) {
  const link = path.join(dir, "openleaf");
  const current = linkTarget(link);
  if (current !== null) {
    const resolved = path.resolve(dir, current);
    if (resolved === entry) return link;
    if (fs.existsSync(resolved) && !force) {
      console.error(`openleaf already points to ${resolved}; run openleaf install-cli --force here to switch.`);
      return null;
    }
    fs.unlinkSync(link);
    fs.symlinkSync(entry, link);
    return link;
  }
  if (fs.existsSync(link)) return null;
  fs.symlinkSync(entry, link);
  return link;
}

function installWindows(dir) {
  const cmdPath = path.join(dir, "openleaf.cmd");
  const shPath = path.join(dir, "openleaf");
  const bodies = windowsShimBodies(process.execPath, entry);
  if (fs.existsSync(cmdPath)) {
    const current = fs.readFileSync(cmdPath, "utf8");
    if (!current.includes(entry) && !current.includes("cli\\bin\\openleaf.js") && !current.includes("cli/bin/openleaf.js")) {
      return null;
    }
  }
  if (fs.existsSync(shPath)) {
    const current = fs.readFileSync(shPath, "utf8");
    if (!current.includes("openleaf.js")) return null;
  }
  fs.writeFileSync(cmdPath, bodies.cmd);
  fs.writeFileSync(shPath, bodies.sh);
  return cmdPath;
}

function ensureShellPath(binDir) {
  if (pathContains(process.env.PATH ?? "", binDir, process.platform)) return null;
  if (process.platform === "win32") {
    console.error(`Add this directory to your user PATH, then open a new terminal: ${binDir}`);
    return null;
  }
  const file = shellStartupFile(process.platform, process.env.SHELL, os.homedir());
  if (!file) return null;
  const fish = file.endsWith(`${path.sep}config.fish`);
  const snippet = pathExportSnippet(binDir, os.homedir(), fish);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (!existing.includes(MARKER)) {
      const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      fs.appendFileSync(file, `${prefix}${snippet}`);
    }
    return file;
  } catch (err) {
    console.error(`Could not update ${file} (${err instanceof Error ? err.message : String(err)}).`);
    console.error(`Add this directory to PATH, then open a new terminal: ${binDir}`);
    return null;
  }
}

function uninstall(dir) {
  if (process.platform === "win32") {
    for (const name of ["openleaf.cmd", "openleaf"]) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    console.log(`Removed openleaf commands from ${dir}`);
    return;
  }
  const link = path.join(dir, "openleaf");
  const current = linkTarget(link);
  if (current === null) {
    console.error(`No openleaf command in ${dir}`);
    return;
  }
  const resolved = path.resolve(dir, current);
  if (resolved !== entry) {
    console.error(`openleaf at ${link} points to ${resolved}, not this checkout. Not removed.`);
    return;
  }
  fs.unlinkSync(link);
  console.log(`Removed ${link}`);
}

function main() {
  const force = process.argv.includes("--force");
  const addToPath = process.argv.includes("--add-to-path");
  const removing = process.argv.includes("--uninstall");
  if ((process.env.CI || process.env.OPENLEAF_SKIP_BIN === "1") && !force && !addToPath && !removing) return;
  if (!fs.existsSync(entry)) {
    console.error(`openleaf launcher not found at ${entry}`);
    return;
  }
  const candidates = binCandidates({
    env: process.env,
    platform: process.platform,
    execPath: process.execPath,
    homedir: os.homedir(),
    nvmVersions: nvmBinDir(),
  });
  const dir = chooseBinDir(candidates, process.env.PATH ?? "", process.platform, writable);
  if (!dir) {
    console.error("Could not install the openleaf command onto PATH. From the repository, run: node cli/bin/openleaf.js");
    return;
  }
  if (removing) {
    uninstall(dir);
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  const installed = process.platform === "win32" ? installWindows(dir) : installUnix(dir, force);
  if (!installed) return;
  console.log(`openleaf command: ${installed}`);
  if (!addToPath) return;
  const rc = ensureShellPath(dir);
  if (rc) console.log(`PATH updated in ${rc}. Open a new terminal, then run: openleaf help`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
