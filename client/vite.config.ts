import os from "node:os";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function lanIp(): string | undefined {
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return undefined;
}

const ip = lanIp();
const port = Number(process.env.OPENLEAF_CLIENT_PORT || 5173);
const apiPort = Number(process.env.OPENLEAF_PORT || 8787);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port,
    strictPort: true,
    open: ip ? `http://${ip}:${port}/` : true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
      "/ai": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
      "/join": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
      "/collab": {
        target: `ws://127.0.0.1:${apiPort}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
