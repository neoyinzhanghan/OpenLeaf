/** Versioned, portable (encrypted) artifacts that sit with the paper. */
export const TRAJECTORY_MISC_DIR = "misc/cursor-trajectories";
/** Recipients file committed with the paper (public age keys only). */
export const TRAJECTORY_RECIPIENTS_FILE = `${TRAJECTORY_MISC_DIR}/recipients.txt`;
/** Private plaintext spool — gitignored via `.openleaf/`. */
export const TRAJECTORY_SPOOL_DIR = ".openleaf/cursor-trajectories/spool";
/** Pending / session state next to the papers root (not inside a paper). */
export const TRAJECTORY_RUNTIME_DIR = ".openleaf-runtime/cursor-trajectories";

export const TRAJECTORY_SCHEMA_VERSION = 1 as const;

export const HOOK_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "beforeSubmitPrompt",
  "afterAgentThought",
  "afterAgentResponse",
  "postToolUse",
  "postToolUseFailure",
  "subagentStart",
  "subagentStop",
  "afterShellExecution",
  "afterMCPExecution",
  "afterFileEdit",
  "stop",
] as const;

export type TrajectoryHookEvent = (typeof HOOK_EVENTS)[number];

export function isCursorTrajectoryRel(rel: string): boolean {
  const n = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    n === "misc/cursor-trajectories" ||
    n.startsWith("misc/cursor-trajectories/") ||
    n === ".openleaf/cursor-trajectories" ||
    n.startsWith(".openleaf/cursor-trajectories/")
  );
}
