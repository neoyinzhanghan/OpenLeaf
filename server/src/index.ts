import cors from "cors";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getPublicConfig, loadConfig, REPO_ROOT } from "./config.js";
import { attachCollabServer } from "./services/collab/server.js";
import { ensureProjectsRoot } from "./services/projectFs.js";
import { configRouter } from "./routes/config.js";
import { identitiesRouter } from "./routes/identities.js";
import { projectsRouter } from "./routes/projects.js";

function lanIp(): string | undefined {
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return undefined;
}

async function main() {
  loadConfig(true);
  await ensureProjectsRoot();

  const app = express();
  const cfg = getPublicConfig();

  app.use(cors());
  app.use(express.json({ limit: "20mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, name: "openleaf" });
  });

  app.use("/api/config", configRouter);
  app.use("/api/identities", identitiesRouter);
  app.use("/api/projects", projectsRouter);

  // Serve built client only in production (`npm start`). In `npm run dev`, Vite
  // on cfg.client.devPort is the UI — serving a stale client/dist here hides new features.
  const clientDist = path.resolve(REPO_ROOT, "client/dist");
  const serveBuiltClient =
    process.env.NODE_ENV === "production" && fs.existsSync(clientDist);
  if (serveBuiltClient) {
    app.use(express.static(clientDist));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/collab")) return next();
      res.sendFile(path.join(clientDist, "index.html"));
    });
  } else {
    // Browser hits on the API port during `npm run dev` → send them to Vite.
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/collab")) return next();
      const host = req.hostname || lanIp() || "127.0.0.1";
      const target = `http://${host}:${cfg.client.devPort}${req.originalUrl}`;
      res.redirect(302, target);
    });
  }

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error(err);
      res.status(500).json({ error: err instanceof Error ? err.message : "Server error" });
    },
  );

  const server = http.createServer(app);
  attachCollabServer(server);

  server.listen(cfg.port, cfg.host, () => {
    const ip = lanIp() ?? "127.0.0.1";
    console.log(`OpenLeaf API http://${ip}:${cfg.port}`);
    console.log(`Collab WS  ws://${ip}:${cfg.port}/collab/<project>?identity=<id>`);
    console.log(`Projects root: ${path.resolve(REPO_ROOT, cfg.projectsRoot)}`);
    if (serveBuiltClient) {
      console.log(`UI         http://${ip}:${cfg.port}`);
    } else {
      console.log(`Dev UI:    http://${ip}:${cfg.client.devPort} (vite — use this during npm run dev)`);
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
