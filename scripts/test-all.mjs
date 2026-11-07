import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(args) {
  const result = spawnSync("npm", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return result.status ?? 1;
}

const install = spawnSync(process.execPath, ["--test", path.join(root, "scripts", "install-cli-bin.test.mjs")], {
  stdio: "inherit",
});
const clientLogic = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "--test-force-exit", "client/src/**/*.test.ts"],
  {
    stdio: "inherit",
    cwd: root,
  },
);
const server = run(["run", "test", "-w", "server"]);
const cli = run(["run", "test", "-w", "cli"]);
process.exit((install.status ?? 1) || (clientLogic.status ?? 1) || server || cli ? 1 : 0);
