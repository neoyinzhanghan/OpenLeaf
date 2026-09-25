import { spawn, execFileSync } from "node:child_process";
import {
  browserLauncher,
  commandLineHasInstance,
  commandLineProbe,
  INSTANCE_MARKER,
  terminateCommand,
} from "./platform.js";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { createHash } from "node:crypto";
import { getConfigDir, getRepoRoot, loadConfig, writeFileAtomic } from "../../server/src/config.js";

export type InstanceMeta = {
  pid: number;
  instanceId: string;
  port: number;
  host: string;
  repoRoot: string;
  configDir: string;
  logFile: string;
  startedAt: string;
  entry: string;
};

const MARKER = INSTANCE_MARKER;

export function instanceId(): string {
  return createHash("sha256").update(`${getRepoRoot()}\0${getConfigDir()}`).digest("hex").slice(0, 16);
}

export function runtimeDir(): string {
  return path.join(getConfigDir(), "runtime");
}

export function instancePath(): string {
  return path.join(runtimeDir(), "instance.json");
}

export function logPath(): string {
  return path.join(runtimeDir(), "openleaf.log");
}

export function serverEntry(): string {
  const override = process.env.OPENLEAF_SERVER_ENTRY?.trim();
  if (override) return path.resolve(override);
  return path.join(getRepoRoot(), "server", "dist", "index.js");
}

export function clientIndex(): string {
  return path.join(getRepoRoot(), "client", "dist", "index.html");
}

export function readInstance(): InstanceMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(instancePath(), "utf8")) as Partial<InstanceMeta>;
    if (!raw || typeof raw.pid !== "number" || typeof raw.instanceId !== "string") return null;
    return raw as InstanceMeta;
  } catch {
    return null;
  }
}

export function writeInstance(meta: InstanceMeta): void {
  writeFileAtomic(instancePath(), `${JSON.stringify(meta, null, 2)}\n`, 0o600);
}

export function clearInstance(): void {
  try {
    fs.rmSync(instancePath(), { force: true });
  } catch {
    /* ignore */
  }
}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Returns null when this platform cannot prove the command line. Callers must not kill in that case. */
export function readCommandLineSync(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      return fs.readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replace(/\0/g, " ").trim();
    }
    const probe = commandLineProbe(pid);
    if (!probe) return null;
    return execFileSync(probe.file, probe.args, {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

export function belongsToThisInstall(pid: number): boolean {
  return commandLineHasInstance(readCommandLineSync(pid), instanceId());
}

export function editorUrl(host = loadConfig().host, port = loadConfig().port): string {
  const bind = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${bind}:${port}`;
}

function probeHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

/** True when a TCP server is already accepting connections. Does not depend on HTTP. */
export function portAccepting(port: number, host: string): Promise<boolean> {
  const bind = probeHost(host);
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: bind });
    const done = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(800);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function httpGet(url: string, timeoutMs: number): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

export async function healthOk(port: number, host: string): Promise<boolean> {
  const bind = probeHost(host);
  const res = await httpGet(`http://${bind}:${port}/api/health`, 1500);
  if (!res || res.status < 200 || res.status >= 300) return false;
  try {
    const body = JSON.parse(res.body) as { ok?: boolean; name?: string };
    return body.ok === true && body.name === "openleaf";
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntilHealthy(port: number, host: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthOk(port, host)) return true;
    await sleep(250);
  }
  return false;
}

export type StartResult =
  | { status: "already-running"; url: string; pid: number }
  | { status: "started"; url: string; pid: number }
  | { status: "failed"; message: string };

export async function startServer(): Promise<StartResult> {
  const cfg = loadConfig(true);
  const existing = readInstance();
  if (existing && processAlive(existing.pid) && belongsToThisInstall(existing.pid)) {
    const healthy = await healthOk(existing.port, existing.host);
    if (healthy) {
      return { status: "already-running", url: editorUrl(existing.host, existing.port), pid: existing.pid };
    }
  }
  if (existing && (!processAlive(existing.pid) || !belongsToThisInstall(existing.pid))) {
    clearInstance();
  }

  const entry = serverEntry();
  if (!fs.existsSync(entry)) {
    return {
      status: "failed",
      message: `Server build not found (${entry}). From the repository root run: npm run build`,
    };
  }
  if (!process.env.OPENLEAF_SERVER_ENTRY && !fs.existsSync(clientIndex())) {
    return {
      status: "failed",
      message: "Editor build not found (client/dist). From the repository root run: npm run build",
    };
  }

  if (await portAccepting(cfg.port, cfg.host)) {
    return {
      status: "failed",
      message: `Port ${cfg.port} is already in use by another program. OpenLeaf will not stop it. Set a different port in config/local.json or OPENLEAF_PORT, then run openleaf start again.`,
    };
  }

  fs.mkdirSync(runtimeDir(), { recursive: true });
  const logFile = logPath();
  const logFd = fs.openSync(logFile, "a");
  const id = instanceId();
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", OPENLEAF_INSTANCE_ID: id };
  delete childEnv.OPENLEAF_HOST_PASSWORD;
  if (cfg.access && cfg.access !== "remote" && !process.env.OPENLEAF_HOST_GATEWAY) {
    childEnv.OPENLEAF_HOST_GATEWAY = "0";
  }

  const child = spawn(process.execPath, [entry, `${MARKER}${id}`], {
    cwd: getRepoRoot(),
    env: childEnv,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(logFd);
  const pid = child.pid;
  if (!pid) return { status: "failed", message: "Failed to spawn the OpenLeaf server." };

  const meta: InstanceMeta = {
    pid,
    instanceId: id,
    port: cfg.port,
    host: cfg.host,
    repoRoot: getRepoRoot(),
    configDir: getConfigDir(),
    logFile,
    startedAt: new Date().toISOString(),
    entry,
  };
  writeInstance(meta);

  const ready = await waitUntilHealthy(cfg.port, cfg.host, 20_000);
  if (!ready || !processAlive(pid)) {
    await stopPid(pid);
    clearInstance();
    const tail = tailLog(12);
    return {
      status: "failed",
      message: `OpenLeaf did not become ready on ${editorUrl(cfg.host, cfg.port)}.${tail ? `\nRecent log:\n${tail}` : ""}`,
    };
  }
  return { status: "started", url: editorUrl(cfg.host, cfg.port), pid };
}

function signalPid(pid: number, force: boolean): void {
  const plan = terminateCommand(pid, force);
  if ("file" in plan) {
    execFileSync(plan.file, plan.args, { windowsHide: true, timeout: 8000, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, plan.signal);
  } catch {
    process.kill(pid, plan.signal);
  }
}

async function stopPid(pid: number): Promise<void> {
  if (!processAlive(pid)) return;
  try {
    signalPid(pid, false);
  } catch {
    /* already gone or the gentle stop is unsupported */
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return;
    await sleep(150);
  }
  try {
    signalPid(pid, true);
  } catch {
    /* already gone */
  }
}

export async function stopServer(): Promise<{ stopped: boolean; message: string }> {
  const meta = readInstance();
  if (!meta) return { stopped: false, message: "OpenLeaf is not running (no instance metadata)." };
  if (!processAlive(meta.pid)) {
    clearInstance();
    return { stopped: true, message: "Cleared stale instance metadata. The recorded process was already gone." };
  }
  if (!belongsToThisInstall(meta.pid)) {
    return {
      stopped: false,
      message: `Refusing to stop pid ${meta.pid}: its command line is not this OpenLeaf install. The metadata was left in place. Nothing else was killed.`,
    };
  }
  await stopPid(meta.pid);
  clearInstance();
  return { stopped: true, message: `Stopped OpenLeaf (pid ${meta.pid}).` };
}

export function tailLog(lines: number): string {
  try {
    const text = fs.readFileSync(logPath(), "utf8");
    return text.split(/\r?\n/).slice(-lines).join("\n").trim();
  } catch {
    return "";
  }
}

export function openEditor(url: string): { opened: boolean; message: string } {
  if (!process.stdin.isTTY && process.env.OPENLEAF_FORCE_OPEN !== "1") {
    return { opened: false, message: `No desktop session assumed. Open ${url}` };
  }
  const launch = browserLauncher(url);
  if (!launch) return { opened: false, message: `Open ${url}` };
  try {
    const child = spawn(launch.file, launch.args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return { opened: true, message: `Opened ${url}` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { opened: false, message: `Could not launch a browser (${detail}). Open ${url}` };
  }
}
