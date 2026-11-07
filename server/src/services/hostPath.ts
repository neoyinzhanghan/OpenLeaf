import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Operating system the browser asked us to format a path for. */
export type PathOs = "windows" | "mac" | "linux" | "other";

export function isWsl(): boolean {
  if (os.platform() !== "linux") return false;
  try {
    return fs.readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

export function parsePathOs(value: unknown): PathOs {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "windows" || s === "win32" || s === "win") return "windows";
  if (s === "mac" || s === "darwin" || s === "macos") return "mac";
  if (s === "linux") return "linux";
  return "other";
}

export function pathSyntaxFor(
  clientOs: PathOs,
  host: { platform: NodeJS.Platform; wsl: boolean },
): "windows" | "posix" {
  const hostIsWindows = host.platform === "win32" || host.wsl;
  if (clientOs === "windows" && hostIsWindows) return "windows";
  if (clientOs === "mac" || clientOs === "linux") return "posix";
  if (hostIsWindows) return "windows";
  return "posix";
}

/** Join a WSL Windows prefix (`\\wsl.localhost\Ubuntu`) with a POSIX absolute path. */
export function toWindowsUnc(prefix: string, posixAbsolute: string): string {
  const base = prefix.replace(/[\\/]+$/, "");
  const rest = posixAbsolute.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\//g, "\\");
  return rest ? `${base}\\${rest}` : `${base}\\`;
}

let prefixPromise: Promise<string | null> | null = null;

async function wslWindowsPrefix(): Promise<string | null> {
  if (!isWsl()) return null;
  if (!prefixPromise) {
    prefixPromise = (async () => {
      try {
        const { stdout } = await execFileAsync("wslpath", ["-w", "/"], { timeout: 4000 });
        const line = stdout.trim();
        if (line) return line.replace(/[\\/]+$/, "");
      } catch {
        /* fall through */
      }
      const distro = process.env.WSL_DISTRO_NAME?.trim();
      return distro ? `\\\\wsl.localhost\\${distro}` : null;
    })();
  }
  return prefixPromise;
}

async function windowsPathFromWsl(absolute: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("wslpath", ["-w", absolute], { timeout: 4000 });
    const line = stdout.trim();
    if (line) return line;
  } catch {
    /* fall through to the cached prefix */
  }
  const prefix = await wslWindowsPrefix();
  if (!prefix) return absolute.split(path.sep).join("/");
  return toWindowsUnc(prefix, absolute.split(path.sep).join("/"));
}

/**
 * Absolute path in the syntax the viewer's operating system uses.
 * A Windows browser on a WSL host gets a `\\wsl.localhost\…` path.
 * A Mac or Linux browser gets a POSIX path. A phone gets the host computer's form.
 */
export async function formatAbsolutePath(absolute: string, clientOs: PathOs): Promise<string> {
  const abs = path.resolve(absolute);
  const host = { platform: os.platform(), wsl: isWsl() };
  const syntax = pathSyntaxFor(clientOs, host);
  if (syntax === "posix") {
    return host.platform === "win32" ? abs : abs.split(path.sep).join("/");
  }
  if (host.platform === "win32") return abs;
  return windowsPathFromWsl(abs);
}
