#!/usr/bin/env node
/**
 * Bootstrap that works after `npm install` and before `npm run build`.
 * TypeScript is loaded with tsx; the Express server is not imported here.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const main = path.join(here, "../src/main.ts");

function tsxResolvable() {
  const candidates = [
    path.join(repoRoot, "node_modules/tsx/package.json"),
    path.join(here, "../node_modules/tsx/package.json"),
  ];
  return candidates.some((file) => fs.existsSync(file));
}

if (!tsxResolvable()) {
  console.error("OpenLeaf's CLI dependencies are not installed yet.");
  console.error("From the repository root, run: npm install");
  console.error("Then: node cli/bin/openleaf.js");
  process.exit(1);
}

const tsxLoader = path.join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs");
const child = spawn(
  process.execPath,
  ["--import", pathToFileURL(tsxLoader).href, main, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal && process.platform !== "win32") {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
