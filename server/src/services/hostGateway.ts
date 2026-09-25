import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfigDir, loadConfig } from "../config.js";
import { updateHostCredentialsUrl } from "./hostAuth.js";

/**
 * Always-on public hostname for the host UI (login-gated).
 * Cloudflare Quick Tunnels assign a new *.trycloudflare.com name whenever
 * this process restarts. Named-tunnel tokens (OPENLEAF_HOST_TUNNEL_TOKEN +
 * OPENLEAF_HOST_PUBLIC_HOSTNAME) keep a stable hostname if you add one later.
 */

export type HostGatewayStatus = "starting" | "active" | "stopped" | "error";

export type HostGateway = {
  hostname: string;
  url: string;
  proc: ChildProcess | null;
  status: HostGatewayStatus;
  error?: string;
  dnsReady: boolean;
  dnsProbeTimer: NodeJS.Timeout | null;
  restartTimer: NodeJS.Timeout | null;
  logTail: string[];
  localOnly: boolean;
  startedAt: number;
};

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

let gateway: HostGateway | null = null;
let stopping = false;
let restartAttempt = 0;

function persistPath(): string {
  const dir = process.env.OPENLEAF_HOST_AUTH_DIR || getConfigDir();
  return path.join(dir, "host-gateway.json");
}

function persist(): void {
  if (!gateway) return;
  const dir = path.dirname(persistPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    persistPath(),
    `${JSON.stringify(
      {
        url: gateway.url,
        hostname: gateway.hostname,
        status: gateway.status,
        dnsReady: gateway.dnsReady || gateway.localOnly,
        localOnly: gateway.localOnly,
        startedAt: gateway.startedAt,
        updatedAt: Date.now(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  if (gateway.url && !gateway.localOnly) updateHostCredentialsUrl(gateway.url);
}

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

function envHostname(): string {
  const raw = (process.env.OPENLEAF_HOST_PUBLIC_HOSTNAME || "").trim().toLowerCase();
  return raw.replace(/^https?:\/\//, "").split("/")[0]?.split(":")[0] ?? "";
}

function envPublicUrl(): string {
  const url = (process.env.OPENLEAF_HOST_PUBLIC_URL || "").trim();
  if (url) return url.replace(/\/$/, "");
  const host = envHostname();
  return host ? `https://${host}` : "";
}

export function isHostGatewayHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase().split(":")[0] ?? "";
  if (!host) return false;
  const envHost = envHostname();
  if (envHost && host === envHost) return true;
  if (gateway?.hostname && host === gateway.hostname) return true;
  return false;
}

export function getHostGateway(): HostGateway | null {
  return gateway;
}

export function hostGatewayPublicView() {
  const g = gateway;
  const envUrl = envPublicUrl();
  if (!g) {
    return {
      url: envUrl,
      hostname: envHostname(),
      status: "stopped" as const,
      dnsReady: Boolean(envUrl),
      localOnly: !envUrl,
    };
  }
  return {
    url: g.url || envUrl,
    hostname: g.hostname || envHostname(),
    status: g.status,
    dnsReady: g.dnsReady || g.localOnly || Boolean(envUrl),
    localOnly: g.localOnly && !envUrl,
  };
}

function pushLog(g: HostGateway, line: string) {
  g.logTail.push(line);
  if (g.logTail.length > 80) g.logTail.splice(0, g.logTail.length - 80);
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

function startDnsProbe(g: HostGateway): void {
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
      persist();
      console.log(`[host-gateway] DNS ready for ${g.hostname}`);
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

function killProc(g: HostGateway) {
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

function teardown(g: HostGateway) {
  if (g.dnsProbeTimer) {
    clearTimeout(g.dnsProbeTimer);
    g.dnsProbeTimer = null;
  }
  if (g.restartTimer) {
    clearTimeout(g.restartTimer);
    g.restartTimer = null;
  }
}

function disabled(): boolean {
  const v = (process.env.OPENLEAF_HOST_GATEWAY || "1").trim().toLowerCase();
  return v === "0" || v === "false" || v === "off";
}

function localFallback(reason: string): HostGateway {
  const g: HostGateway = {
    hostname: envHostname(),
    url: envPublicUrl(),
    proc: null,
    status: envPublicUrl() ? "active" : "stopped",
    error: reason,
    dnsReady: Boolean(envPublicUrl()),
    dnsProbeTimer: null,
    restartTimer: null,
    logTail: [reason],
    localOnly: !envPublicUrl(),
    startedAt: Date.now(),
  };
  gateway = g;
  persist();
  return g;
}

function scheduleRestart(): void {
  if (stopping || disabled()) return;
  restartAttempt += 1;
  const delay = Math.min(60_000, 2000 * 2 ** Math.min(restartAttempt - 1, 5));
  console.warn(`[host-gateway] restarting in ${Math.round(delay / 1000)}s (attempt ${restartAttempt})`);
  const t = setTimeout(() => {
    void startHostGateway();
  }, delay);
  t.unref();
  if (gateway) gateway.restartTimer = t;
}

/**
 * Start (or reuse) the host public tunnel. Safe to call more than once.
 */
export async function startHostGateway(): Promise<HostGateway> {
  if (disabled()) return localFallback("Host gateway disabled (OPENLEAF_HOST_GATEWAY=0)");

  if (gateway && (gateway.status === "active" || gateway.status === "starting") && gateway.proc) {
    return gateway;
  }

  const token = (process.env.OPENLEAF_HOST_TUNNEL_TOKEN || "").trim();
  let bin: string;
  try {
    bin = findCloudflared();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[host-gateway] ${msg}`);
    return localFallback(msg);
  }

  const port = loadConfig().port;
  const g: HostGateway = {
    hostname: envHostname(),
    url: envPublicUrl(),
    proc: null,
    status: "starting",
    dnsReady: Boolean(envPublicUrl()),
    dnsProbeTimer: null,
    restartTimer: null,
    logTail: [],
    localOnly: false,
    startedAt: Date.now(),
  };
  gateway = g;

  const args = token
    ? ["tunnel", "--no-autoupdate", "run", "--token", token]
    : ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate", "--protocol", "quic"];

  const proc = spawn(bin, args, {
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
      () => finish(new Error("Timed out waiting for the host Cloudflare tunnel (45s)")),
      45_000,
    );

    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        pushLog(g, line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s+/, ""));
        if (!g.url || g.url === envPublicUrl()) {
          const m = line.match(TUNNEL_URL_RE);
          if (m) {
            g.url = m[0].toLowerCase();
            g.hostname = new URL(g.url).hostname;
            persist();
          }
        }
        if ((g.url || token) && /Registered tunnel connection/i.test(line)) finish();
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
      persist();
    }
    teardown(g);
    if (gateway === g) g.proc = null;
    if (!stopping) scheduleRestart();
  });

  try {
    await ready;
  } catch (err) {
    g.status = "error";
    g.error = err instanceof Error ? err.message : String(err);
    killProc(g);
    teardown(g);
    persist();
    console.warn(`[host-gateway] tunnel failed (${g.error})`);
    scheduleRestart();
    return g;
  }

  g.status = "active";
  restartAttempt = 0;
  if (g.hostname && !g.dnsReady) startDnsProbe(g);
  persist();
  console.log(`[host-gateway] ${g.url || envPublicUrl() || "(named tunnel)"}`);
  return g;
}

export function stopHostGateway(): void {
  stopping = true;
  const g = gateway;
  if (!g) return;
  g.status = "stopped";
  killProc(g);
  teardown(g);
  persist();
  gateway = null;
  console.log("[host-gateway] stopped");
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(sig, () => {
    stopHostGateway();
  });
}
process.once("exit", () => {
  if (gateway) killProc(gateway);
});
