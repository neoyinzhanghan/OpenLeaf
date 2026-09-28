import type { Express } from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import type { Server as HttpServer } from "node:http";
import { loadConfig } from "../config.js";
import { listDevices, outstandingPairingCount } from "./hostDevices.js";

type Attach = (server: HttpServer) => void;

let app: Express | null = null;
let attach: Attach | null = null;
let current: { server: HttpServer; address: string; port: number } | null = null;
let idle: NodeJS.Timeout | null = null;

export function registerLanRuntime(expressApp: Express, attachUpgrades: Attach): void {
  app = expressApp;
  attach = attachUpgrades;
}

export type LanAddress = {
  address: string;
  name: string;
  kind: "wifi" | "tailscale" | "virtual";
  label: string;
};

function kindOf(name: string, address: string): LanAddress["kind"] {
  if (address.startsWith("100.")) return "tailscale";
  if (/^(docker|br-|veth|vEthernet|utun)/i.test(name)) return "virtual";
  return "wifi";
}

function rank(kind: LanAddress["kind"]): number {
  if (kind === "wifi") return 0;
  if (kind === "tailscale") return 1;
  return 2;
}

function privateRank(address: string): number {
  if (address.startsWith("192.168.")) return 0;
  if (address.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) return 2;
  return 3;
}

export function lanAddresses(): { wsl: boolean; addresses: LanAddress[] } {
  const addresses: LanAddress[] = [];
  for (const [name, nets] of Object.entries(os.networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family !== "IPv4" || net.internal) continue;
      const kind = kindOf(name, net.address);
      const label =
        kind === "tailscale"
          ? `Tailscale (works anywhere on your tailnet) · ${net.address}`
          : kind === "virtual"
            ? `${name} · ${net.address}`
            : `${name} · ${net.address}`;
      addresses.push({ address: net.address, name, kind, label });
    }
  }
  addresses.sort((a, b) => rank(a.kind) - rank(b.kind) || privateRank(a.address) - privateRank(b.address));
  let wsl = false;
  try {
    wsl = os.platform() === "linux" && fs.readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    wsl = false;
  }
  return { wsl, addresses };
}

export function startLanAccess(address: string, port: number): Promise<void> {
  if (!app || !attach) {
    return Promise.reject(Object.assign(new Error("Phone access is not ready yet."), { status: 500 }));
  }
  if (current && current.address === address && current.port === port) return Promise.resolve();
  stopLanAccess();
  const server = http.createServer(app);
  attach(server);
  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && loadConfig().host === "0.0.0.0") {
        scheduleIdleCheck();
        resolve();
        return;
      }
      const message =
        err.code === "EADDRINUSE"
          ? `Port ${port} is already in use on ${address}. Is OpenLeaf already running? Try openleaf status.`
          : err.message;
      reject(Object.assign(new Error(message), { status: 500 }));
    });
    server.listen(port, address, () => {
      current = { server, address, port };
      scheduleIdleCheck();
      resolve();
    });
  });
}

export function stopLanAccess(): void {
  if (idle) {
    clearInterval(idle);
    idle = null;
  }
  const running = current;
  current = null;
  if (!running) return;
  running.server.close();
}

export function lanAccessRunning(): { address: string; port: number } | null {
  return current ? { address: current.address, port: current.port } : null;
}

function scheduleIdleCheck(): void {
  if (idle) clearInterval(idle);
  const started = Date.now();
  idle = setInterval(() => {
    const paired = listDevices().some((device) => !device.revokedAt);
    if (paired || outstandingPairingCount() > 0) return;
    if (Date.now() - started < 15 * 60_000) return;
    stopLanAccess();
  }, 60_000);
  idle.unref();
}
