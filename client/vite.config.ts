import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));

function configuredAccess(): string {
  const fromEnv = process.env.OPENLEAF_ACCESS?.trim();
  if (fromEnv) return fromEnv;
  const configDir = process.env.OPENLEAF_CONFIG_DIR?.trim() || path.resolve(here, "../config");
  for (const name of ["local.json", "default.json"]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(configDir, name), "utf8")) as { access?: string };
      if (parsed.access) return parsed.access;
    } catch {
      /* try the next file */
    }
  }
  return "localhost";
}

const access = configuredAccess();
const expose = access === "lan" || access === "remote";
const port = Number(process.env.OPENLEAF_CLIENT_PORT || 5173);
const apiPort = Number(process.env.OPENLEAF_PORT || 8787);
const apiTarget = `http://127.0.0.1:${apiPort}`;

function apiProxy(ws = false) {
  return {
    target: ws ? `ws://127.0.0.1:${apiPort}` : apiTarget,
    changeOrigin: false,
    xfwd: true,
    ws,
    configure: (proxy: { on: (event: string, handler: (...args: unknown[]) => void) => void }) => {
      proxy.on("proxyReq", (proxyReq: { removeHeader: (name: string) => void; setHeader: (name: string, value: string) => void }, req: { socket?: { remoteAddress?: string }; headers: { host?: string } }) => {
        // Drop caller-supplied forwarding headers, then record only this hop.
        for (const name of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "cf-connecting-ip"]) {
          proxyReq.removeHeader(name);
        }
        const peer = req.socket?.remoteAddress ?? "";
        if (peer) proxyReq.setHeader("x-forwarded-for", peer);
        if (req.headers.host) proxyReq.setHeader("x-forwarded-host", req.headers.host);
      });
    },
  };
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: expose ? "0.0.0.0" : "127.0.0.1",
    port,
    strictPort: true,
    open: true,
    proxy: {
      "/api": apiProxy(),
      "/ai": apiProxy(),
      "/library-ai": apiProxy(),
      "/join": apiProxy(),
      "/host": apiProxy(),
      "/collab": apiProxy(true),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
