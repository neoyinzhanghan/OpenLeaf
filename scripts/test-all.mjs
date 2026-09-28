import { spawnSync } from "node:child_process";

function run(args) {
  const result = spawnSync("npm", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return result.status ?? 1;
}

const server = run(["run", "test", "-w", "server"]);
const cli = run(["run", "test", "-w", "cli"]);
process.exit(server || cli ? 1 : 0);
