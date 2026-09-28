import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
const repo = process.cwd();

export type Instance = {
  baseURL: string;
  projects: string;
  stop: () => Promise<void>;
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export async function startInstance(): Promise<Instance> {
  const port = await freePort();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "openleaf-e2e-"));
  const configDir = path.join(sandbox, "config");
  const projects = path.join(sandbox, "projects");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  fs.copyFileSync(path.join(repo, "config/default.json"), path.join(configDir, "default.json"));
  fs.writeFileSync(
    path.join(configDir, "local.json"),
    `${JSON.stringify({
      host: "127.0.0.1",
      port,
      access: "localhost",
      projectsRoot: projects,
      libraryRoot: path.join(sandbox, "library"),
    })}\n`,
  );
  const child: ChildProcess = spawn("npx", ["tsx", "server/src/index.ts"], {
    cwd: repo,
    env: {
      ...process.env,
      NODE_ENV: "production",
      OPENLEAF_CONFIG_DIR: configDir,
      OPENLEAF_HOST_AUTH_DIR: configDir,
      OPENLEAF_PROJECTS_ROOT: projects,
      OPENLEAF_LIBRARY_ROOT: path.join(sandbox, "library"),
      OPENLEAF_PORT: String(port),
      OPENLEAF_HOST_GATEWAY: "0",
      OPENLEAF_TUNNEL_SKIP_DNS: "1",
      OPENLEAF_CLOUDFLARED: path.join(repo, "e2e/fake-cloudflared.sh"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const baseURL = `http://127.0.0.1:${port}`;
  let log = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited\n${log}`);
    try {
      const res = await fetch(`${baseURL}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const health = await fetch(`${baseURL}/api/health`).catch(() => null);
  if (!health?.ok) throw new Error(`server did not become healthy\n${log}`);
  return {
    baseURL,
    projects,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) {
          fs.rmSync(sandbox, { recursive: true, force: true });
          resolve();
          return;
        }
        child.once("exit", () => {
          fs.rmSync(sandbox, { recursive: true, force: true });
          resolve();
        });
        child.kill("SIGTERM");
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 4000).unref();
      }),
  };
}
