import { createHash } from "node:crypto";
import { HOOK_EVENTS, TRAJECTORY_SCHEMA_VERSION, type TrajectoryHookEvent } from "./constants.js";

export type Attribution = {
  projectId: string;
  branchId: string;
};

export type TrajectoryRecord = {
  v: typeof TRAJECTORY_SCHEMA_VERSION;
  seq: number;
  prevHash: string;
  hash: string;
  ts: string;
  hook: string;
  conversation_id: string;
  generation_id: string;
  session_id: string;
  model: string | null;
  model_id: string | null;
  cursor_version: string | null;
  attributed: Attribution[];
  payload: unknown;
};

export type TurnHeader = {
  v: typeof TRAJECTORY_SCHEMA_VERSION;
  kind: "turn";
  conversation_id: string;
  generation_id: string;
  projectIds: string[];
  branches: Attribution[];
  encryptedAt: string;
  eventCount: number;
  model: string | null;
  cursor_version: string | null;
};

export type SessionState = {
  conversationId: string;
  attributed: Attribution[];
  model: string | null;
  cursorVersion: string | null;
  transcriptPath: string | null;
  generations: Record<
    string,
    {
      seq: number;
      lastHash: string;
      seen: string[];
      flushed: boolean;
    }
  >;
};

export function genesisHash(): string {
  return "sha256:" + "0".repeat(64);
}

export function hashRecord(seq: number, prevHash: string, body: unknown): string {
  const payload = JSON.stringify({ seq, prevHash, body });
  return "sha256:" + createHash("sha256").update(payload).digest("hex");
}

export function dedupKey(hook: string, payload: Record<string, unknown>, generationId: string): string {
  const toolId = str(payload.tool_use_id) || str(payload.tool_call_id) || str(payload.subagent_id);
  if (toolId) return `${hook}:${toolId}`;
  if (hook === "beforeSubmitPrompt") return `${hook}:${hashText(str(payload.prompt) ?? "")}`;
  if (hook === "afterAgentThought" || hook === "afterAgentResponse") {
    return `${hook}:${hashText(str(payload.text) ?? "")}`;
  }
  if (hook === "afterFileEdit") {
    return `${hook}:${str(payload.file_path) ?? ""}:${hashText(JSON.stringify(payload.edits ?? []))}`;
  }
  if (hook === "stop" || hook === "sessionStart" || hook === "sessionEnd") {
    return `${hook}:${generationId}`;
  }
  return `${hook}:${hashText(JSON.stringify(payload))}`;
}

export function isTrackedHook(name: string): name is TrajectoryHookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(name);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
