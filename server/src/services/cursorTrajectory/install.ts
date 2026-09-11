import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT, getProjectsRootAbs } from "../../config.js";
import { HOOK_EVENTS } from "./constants.js";

export const PROJECT_HOOKS_VERSION = 1;

const HOOKS_JSON = JSON.stringify(
  {
    version: 1,
    hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ command: ".cursor/hooks/record-trajectory.sh" }]])),
  },
  null,
  2,
) + "\n";

const LAUNCHER = `#!/usr/bin/env bash
# Fail-open: record Cursor agent events for this OpenLeaf paper, even when the
# paper folder is opened as its own Cursor workspace.
set -u
PROJECT_DIR="\${CURSOR_PROJECT_DIR:-\$(cd "\$(dirname "\${BASH_SOURCE[0]}")/../.." && pwd)}"
export OPENLEAF_TRAJECTORY_PROJECT_DIR="\$PROJECT_DIR"

INPUT="\$(mktemp -t openleaf-traj.XXXXXX)" || { echo '{}'; exit 0; }
cleanup() { rm -f "\$INPUT"; }
trap cleanup EXIT
cat > "\$INPUT" || { echo '{}'; exit 0; }

read_openleaf_root() {
  local sidecar="\$PROJECT_DIR/.openleaf/cursor-recorder.json"
  if [[ -f "\$sidecar" ]]; then
    node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(j.openleafRoot||""))' "\$sidecar" 2>/dev/null || true
    return
  fi
}

OPENLEAF="\${OPENLEAF_HOME:-}"
if [[ -z "\$OPENLEAF" ]]; then
  OPENLEAF="\$(read_openleaf_root)"
fi
if [[ -z "\$OPENLEAF" && -f "\$HOME/.openleaf/home" ]]; then
  OPENLEAF="\$(tr -d '[:space:]' < "\$HOME/.openleaf/home")"
fi
if [[ -z "\$OPENLEAF" || ! -d "\$OPENLEAF" ]]; then
  echo '{}'
  exit 0
fi

export OPENLEAF_REPO_ROOT="\$OPENLEAF"
if [[ -z "\${OPENLEAF_PROJECTS_ROOT:-}" ]]; then
  export OPENLEAF_PROJECTS_ROOT="\$(cd "\$PROJECT_DIR/.." && pwd)"
fi

run() { "$@" < "\$INPUT"; }
cd "\$OPENLEAF" || { echo '{}'; exit 0; }

if [[ -f "\$OPENLEAF/server/dist/services/cursorTrajectory/cli.js" ]]; then
  if run node "\$OPENLEAF/server/dist/services/cursorTrajectory/cli.js"; then
    exit 0
  fi
fi
if [[ -x "\$OPENLEAF/node_modules/.bin/tsx" ]]; then
  if run "\$OPENLEAF/node_modules/.bin/tsx" "\$OPENLEAF/server/src/services/cursorTrajectory/cli.ts"; then
    exit 0
  fi
fi
if [[ -x "\$OPENLEAF/server/node_modules/.bin/tsx" ]]; then
  if run "\$OPENLEAF/server/node_modules/.bin/tsx" "\$OPENLEAF/server/src/services/cursorTrajectory/cli.ts"; then
    exit 0
  fi
fi

echo '{}'
exit 0
`;

export function openleafHomePath(): string {
  return path.join(os.homedir(), ".openleaf", "home");
}

/** Remember where this OpenLeaf install lives so paper-local hooks can find the recorder. */
export async function stampOpenleafHome(repoRoot = REPO_ROOT): Promise<void> {
  const dest = openleafHomePath();
  await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  await fs.writeFile(dest, `${repoRoot}\n`, { encoding: "utf8", mode: 0o600 });
}

export function projectRecorderSidecar(projectRoot: string): string {
  return path.join(projectRoot, ".openleaf", "cursor-recorder.json");
}

/** Write Cursor project hooks into a paper so opening that folder standalone records agents. */
export async function ensureProjectCursorHooks(
  projectRoot: string,
  opts?: { openleafRoot?: string },
): Promise<void> {
  const root = path.resolve(projectRoot);
  if (!fsSync.existsSync(root) || !fsSync.statSync(root).isDirectory()) return;
  if (!fsSync.existsSync(path.join(root, "openleaf.json"))) return;

  const openleafRoot = opts?.openleafRoot ?? REPO_ROOT;
  const hooksDir = path.join(root, ".cursor", "hooks");
  await fs.mkdir(hooksDir, { recursive: true });
  await fs.writeFile(path.join(root, ".cursor", "hooks.json"), HOOKS_JSON, "utf8");
  const launcherPath = path.join(hooksDir, "record-trajectory.sh");
  await fs.writeFile(launcherPath, LAUNCHER, { encoding: "utf8", mode: 0o755 });
  await fs.chmod(launcherPath, 0o755).catch(() => undefined);

  const sidecar = projectRecorderSidecar(root);
  await fs.mkdir(path.dirname(sidecar), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    sidecar,
    `${JSON.stringify({ version: PROJECT_HOOKS_VERSION, openleafRoot }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

export async function ensureAllProjectCursorHooks(projectsRoot?: string): Promise<void> {
  const root = projectsRoot ?? getProjectsRootAbs();
  if (!fsSync.existsSync(root)) return;
  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(root, entry.name);
    try {
      await ensureProjectCursorHooks(dir);
    } catch (err) {
      console.error("[cursor-trajectory] failed to install hooks", dir, err);
    }
  }
}
