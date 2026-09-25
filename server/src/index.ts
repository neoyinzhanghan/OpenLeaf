import cors from "cors";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getLibraryRootAbs, getPublicConfig, getRepoRoot, loadConfig } from "./config.js";
import { attachCollabServer } from "./services/collab/server.js";
import { ensureProjectsRoot } from "./services/projectFs.js";
import { ensureLibraryBoot } from "./services/library/index.js";
import { configRouter } from "./routes/config.js";
import { guestRouter, joinRouter } from "./routes/guest.js";
import { hostRouter } from "./routes/host.js";
import { identitiesRouter } from "./routes/identities.js";
import { libraryRouter } from "./routes/library.js";
import { librarySharePublicRouter, libraryShareRouter } from "./routes/libraryShare.js";
import {
  libraryAiApiRouter,
  libraryAiBriefRouter,
  libraryAiHostRouter,
} from "./routes/libraryAi.js";
import { projectsRouter } from "./routes/projects.js";
import { shareRouter } from "./routes/share.js";
import { aiApiRouter, aiBriefRouter } from "./routes/ai.js";
import { ensureHostAuth } from "./services/hostAuth.js";
import { startHostGateway } from "./services/hostGateway.js";
import { hostOnly, shareGate } from "./services/shareAuth.js";
import { invalidJsonMiddleware, isInvalidJsonBodyError } from "./http/jsonErrors.js";

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
  const hostCreds = ensureHostAuth();
  await ensureProjectsRoot();
  await ensureLibraryBoot();

  const app = express();
  const cfg = getPublicConfig();

  app.use(
    cors({
      exposedHeaders: ["Mcp-Session-Id", "MCP-Protocol-Version"],
    }),
  );
  app.use(express.json({ limit: "20mb" }));
  app.use(invalidJsonMiddleware);
  // Classifies every request as host (direct) or guest (via a share tunnel)
  // and enforces guest sign-in + per-share permissions before any router.
  app.use(shareGate);

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, name: "openleaf" });
  });

  app.use("/api/guest", guestRouter);
  app.use("/api/host", hostRouter);
  app.use("/join", joinRouter);
  app.use("/ai", aiBriefRouter);
  app.use("/api/ai", aiApiRouter);
  app.use("/library-ai", libraryAiBriefRouter);
  app.use("/api/library-ai/v1", libraryAiApiRouter);
  app.use("/api/library-ai", libraryAiHostRouter);
  app.use("/api/share", shareRouter);
  app.use("/api/config", hostOnly, configRouter);
  app.use("/api/identities", hostOnly, identitiesRouter);
  // Citation library is host-only (guests use tokenized /api/lib-share instead).
  app.use("/api/library", hostOnly, libraryRouter);
  app.use("/api/library-share", libraryShareRouter);
  app.use("/api/lib-share", librarySharePublicRouter);
  app.use("/api/projects", projectsRouter);

  // Serve built client only in production (`npm start`). In `npm run dev`, Vite
  // on cfg.client.devPort is the UI — serving a stale client/dist here hides new features.
  const clientDist = path.resolve(getRepoRoot(), "client/dist");
  const serveBuiltClient =
    process.env.NODE_ENV === "production" && fs.existsSync(clientDist);
  if (serveBuiltClient) {
    app.use(express.static(clientDist));
    app.get("*", (req, res, next) => {
      if (
        req.path.startsWith("/api") ||
        req.path.startsWith("/collab") ||
        req.path.startsWith("/ai") ||
        req.path.startsWith("/library-ai")
      ) {
        return next();
      }
      res.sendFile(path.join(clientDist, "index.html"));
    });
  } else {
    // Browser hits on the API port during `npm run dev` → send them to Vite.
    app.get("*", (req, res, next) => {
      if (
        req.path.startsWith("/api") ||
        req.path.startsWith("/collab") ||
        req.path.startsWith("/ai") ||
        req.path.startsWith("/library-ai")
      ) {
        return next();
      }
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
      if (isInvalidJsonBodyError(err)) {
        res.status(400).json({ error: "Invalid JSON" });
        return;
      }
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
    if (!process.env.OPENLEAF_HOST_GATEWAY && cfg.access && cfg.access !== "remote") {
      process.env.OPENLEAF_HOST_GATEWAY = "0";
    }
    console.log(`Projects root: ${path.resolve(getRepoRoot(), cfg.projectsRoot)}`);
    console.log(`Library root:  ${getLibraryRootAbs()}`);
    if (serveBuiltClient) {
      console.log(`UI         http://${ip}:${cfg.port}`);
    } else {
      console.log(`Dev UI:    http://${ip}:${cfg.client.devPort} (vite — use this during npm run dev)`);
    }
    if (hostCreds.created) {
      console.log(`Host login username: ${hostCreds.username}`);
      console.log("Host login password written to config/host-credentials.txt (not printed)");
    } else {
      console.log(`Host login username: ${hostCreds.username} (password in config/host-credentials.txt)`);
    }
    void startHostGateway()
      .then((g) => {
        if (g.localOnly || !g.url) {
          console.log("Public host URL: not available (install cloudflared, or set OPENLEAF_HOST_PUBLIC_HOSTNAME)");
          return;
        }
        console.log(`Public host URL: ${g.url}  (sign in as ${hostCreds.username})`);
        if (!g.dnsReady) console.log("Public DNS is still propagating — wait a few seconds before opening the link.");
      })
      .catch((err) => {
        console.warn("[host-gateway] failed to start", err);
      });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
