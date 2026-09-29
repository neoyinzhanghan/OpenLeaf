import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";

/**
 * Per-project public hostname for AI collaborator tools.
 * Independent of human share tunnels: stopping a share does not kill AI URLs.
 * One cloudflared Quick Tunnel per project that has at least one live AI link.
 */

export type AiGatewayStatus = "starting" | "active" | "stopped" | "error";

export type AiGateway = {
  projectId: string;
  hostname: string;
  url: string;
  proc: ChildProcess | null;
  status: AiGatewayStatus;
  error?: string;
  dnsReady: boolean;
  dnsProbeTimer: NodeJS.Timeout | null;
  logTail: string[];
  localOnly: boolean;
};

const byProject = new Map<string, AiGateway>();
const byHost = new Map<string, AiGateway>();

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function findCloudflared(): string {
  const explicit = process.env.OPENLEAF_CLOUDFLARED;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.join(os.homedir(), ".local", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/opt/homebrew/bin",
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    const bin = path.join(dir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
    if (fs.existsSync(bin)) return bin;
  }
  throw new Error(
    "cloudflared not found. Install it (https://github.com/cloudflare/cloudflared/releases) or set OPENLEAF_CLOUDFLARED.",
  );
}

export function localhostOrigin(): string {
  const cfg = loadConfig();
  const host = cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host;
  return `http://${host}:${cfg.port}`;
}

export function getAiGateway(projectId: string): AiGateway | undefined {
  return byProject.get(projectId);
}

export function isAiGatewayHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase().split(":")[0] ?? "";
  return byHost.has(host);
}

function pushLog(g: AiGateway, line: string) {
  g.logTail.push(line);
  if (g.logTail.length > 60) g.logTail.splice(0, g.logTail.length - 60);
}

async function hostnameResolves(hostname: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return false;
    const body = (await res.json()) as { Status?: number; Answer?: Array<{ type: number }> };
    return body.Status === 0 && Array.isArray(body.Answer) && body.Answer.some((a) => a.type === 1);
  } catch {
    return false;
  }
}

function startDnsProbe(g: AiGateway): void {
  if (!g.hostname || g.dnsReady || g.localOnly) return;
  let attempts = 0;
  const maxAttempts = 90;
  const tick = async () => {
    if (g.status !== "active" || g.dnsReady) return;
    attempts += 1;
    const ok = await hostnameResolves(g.hostname);
    if (ok) {
      g.dnsReady = true;
      g.dnsProbeTimer = null;
      console.log(`[ai-gateway] ${g.projectId}: DNS ready for ${g.hostname}`);
      return;
    }
    if (attempts >= maxAttempts) {
      g.dnsProbeTimer = null;
      return;
    }
    g.dnsProbeTimer = setTimeout(() => void tick(), 2000);
  };
  void tick();
}

function killProc(g: AiGateway) {
  const p = g.proc;
  if (!p || p.exitCode !== null || p.killed) return;
  try {
    p.kill("SIGTERM");
    const t = setTimeout(() => {
      try {
        if (p.exitCode === null) p.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 3000);
    t.unref();
  } catch {
    /* ignore */
  }
}

function teardown(g: AiGateway) {
  if (g.dnsProbeTimer) {
    clearTimeout(g.dnsProbeTimer);
    g.dnsProbeTimer = null;
  }
  if (g.hostname && byHost.get(g.hostname) === g) byHost.delete(g.hostname);
}

export function stopAiGateway(projectId: string): void {
  const g = byProject.get(projectId);
  if (!g) return;
  g.status = "stopped";
  killProc(g);
  teardown(g);
  byProject.delete(projectId);
  console.log(`[ai-gateway] ${projectId} stopped`);
}

export function stopAllAiGateways(): void {
  for (const id of Array.from(byProject.keys())) stopAiGateway(id);
}

function localGateway(projectId: string): AiGateway {
  const existing = byProject.get(projectId);
  if (existing?.localOnly && existing.status === "active") return existing;
  const g: AiGateway = {
    projectId,
    hostname: "",
    url: localhostOrigin(),
    proc: null,
    status: "active",
    dnsReady: true,
    dnsProbeTimer: null,
    logTail: [],
    localOnly: true,
  };
  byProject.set(projectId, g);
  return g;
}

function preferLocalGateway(): boolean {
  const v = (process.env.OPENLEAF_AI_GATEWAY || "1").trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "local";
}

/**
 * Return a public (or localhost fallback) origin for AI briefing URLs.
 * Reuses an already-running gateway. Starts cloudflared on first use when available.
 */
export async function ensureAiGateway(projectId: string): Promise<AiGateway> {
  const existing = byProject.get(projectId);
  if (existing && (existing.status === "active" || existing.status === "starting") && existing.url) {
    return existing;
  }

  if (preferLocalGateway()) return localGateway(projectId);

  let bin: string;
  try {
    bin = findCloudflared();
  } catch {
    return localGateway(projectId);
  }

  const port = loadConfig().port;
  const g: AiGateway = {
    projectId,
    hostname: "",
    url: "",
    proc: null,
    status: "starting",
    dnsReady: false,
    dnsProbeTimer: null,
    logTail: [],
    localOnly: false,
  };
  byProject.set(projectId, g);

  const tunnelArgs = ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate", "--protocol", "quic"];
  const shellScript = bin.endsWith(".sh");
  const proc = spawn(shellScript ? "sh" : bin, shellScript ? [bin, ...tunnelArgs] : tunnelArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  g.proc = proc;

  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error("Timed out waiting for the AI Cloudflare tunnel (45s)")),
      45_000,
    );

    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        pushLog(g, line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s+/, ""));
        if (!g.url) {
          const m = line.match(TUNNEL_URL_RE);
          if (m) {
            g.url = m[0].toLowerCase();
            g.hostname = new URL(g.url).hostname;
            byHost.set(g.hostname, g);
          }
        }
        if (g.url && /Registered tunnel connection/i.test(line)) finish();
        if (/failed to request quick Tunnel|ERR .*(unable|cannot|failed to (connect|dial))/i.test(line) && !g.url) {
          finish(new Error(line.replace(/^.*?ERR\s*/, "")));
        }
      }
    };
    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
    proc.once("error", (err) => finish(err));
    proc.once("exit", (code, signal) => {
      finish(new Error(`cloudflared exited early (${signal ?? code ?? "unknown"})`));
    });
  });

  proc.on("exit", (code, signal) => {
    pushLog(g, `cloudflared exited (${signal ?? code ?? "unknown"})`);
    if (g.status === "active") {
      g.status = "stopped";
      g.error = "Tunnel process exited";
    }
    teardown(g);
    if (byProject.get(projectId) === g) byProject.delete(projectId);
  });

  try {
    await ready;
  } catch (err) {
    g.status = "error";
    g.error = err instanceof Error ? err.message : String(err);
    killProc(g);
    teardown(g);
    byProject.delete(projectId);
    console.warn(`[ai-gateway] ${projectId}: tunnel failed (${g.error}); falling back to localhost`);
    return localGateway(projectId);
  }

  g.status = "active";
  startDnsProbe(g);
  console.log(`[ai-gateway] ${projectId} -> ${g.url}`);
  return g;
}

export function gatewayPublicView(g: AiGateway | undefined) {
  if (!g) {
    return {
      url: localhostOrigin(),
      hostname: "",
      status: "stopped" as const,
      dnsReady: true,
      localOnly: true,
    };
  }
  return {
    url: g.url || localhostOrigin(),
    hostname: g.hostname,
    status: g.status,
    dnsReady: g.dnsReady || g.localOnly,
    localOnly: g.localOnly,
  };
}

process.once("exit", () => {
  for (const g of byProject.values()) killProc(g);
});
