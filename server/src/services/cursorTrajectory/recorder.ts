import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { getProjectsRootAbs } from "../../config.js";
import {
  TRAJECTORY_MISC_DIR,
  TRAJECTORY_RECIPIENTS_FILE,
  TRAJECTORY_RUNTIME_DIR,
  TRAJECTORY_SCHEMA_VERSION,
} from "./constants.js";
import {
  decryptWithIdentity,
  defaultUserConfigDir,
  encryptToRecipients,
  parseRecipientsText,
  readRecipientsFile,
  atomicWriteFile,
} from "./encrypt.js";
import {
  attributionsFromPayload,
  branchRootFor,
  safeFsId,
  unionAttributions,
} from "./paths.js";
import {
  dedupKey,
  genesisHash,
  hashRecord,
  isTrackedHook,
  type Attribution,
  type SessionState,
  type TrajectoryRecord,
  type TurnHeader,
} from "./schema.js";
import {
  appendJsonl,
  copySpool,
  emptySession,
  loadSession,
  pendingPath,
  projectSpoolPath,
  readJsonlRecords,
  removeFile,
  saveSession,
  sessionStatePath,
  withFileLock,
} from "./spool.js";

export type RecorderOptions = {
  projectsRoot?: string;
  stateRoot?: string;
  userConfigDir?: string;
  now?: () => Date;
};

export type IngestResult = {
  ingested: boolean;
  skipped?: "untracked" | "duplicate" | "empty";
  encrypted?: string[];
  spoolOnly?: boolean;
  attributed: Attribution[];
};

function projectsRootOf(opts?: RecorderOptions): string {
  return path.resolve(opts?.projectsRoot ?? getProjectsRootAbs());
}

function stateRootOf(opts?: RecorderOptions): string {
  return path.resolve(opts?.stateRoot ?? path.join(projectsRootOf(opts), TRAJECTORY_RUNTIME_DIR));
}

function userConfigDirOf(opts?: RecorderOptions): string {
  return opts?.userConfigDir ?? defaultUserConfigDir();
}

function asObject(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function conversationIdOf(payload: Record<string, unknown>): string {
  return str(payload.conversation_id) || str(payload.session_id) || "unknown";
}

function generationIdOf(payload: Record<string, unknown>, conversationId: string): string {
  return str(payload.generation_id) || conversationId;
}

function hookNameOf(payload: Record<string, unknown>): string {
  return str(payload.hook_event_name) || str(payload.hook) || "";
}

function ensureGen(state: SessionState, generationId: string): SessionState["generations"][string] {
  const existing = state.generations[generationId];
  if (existing) return existing;
  const created = { seq: 0, lastHash: genesisHash(), seen: [] as string[], flushed: false };
  state.generations[generationId] = created;
  return created;
}

export function listRecipients(projectId: string, opts?: RecorderOptions): string[] {
  const projectsRoot = projectsRootOf(opts);
  const fromProject = readRecipientsFile(
    path.join(projectsRoot, projectId, TRAJECTORY_RECIPIENTS_FILE),
  );
  const fromEnv = parseRecipientsText(process.env.OPENLEAF_TRAJECTORY_RECIPIENTS ?? "");
  const fromUser = readRecipientsFile(path.join(userConfigDirOf(opts), "cursor-trajectory.recipients"));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of [...fromProject, ...fromEnv, ...fromUser]) {
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

function canonicalSpool(stateRoot: string, conversationId: string, generationId: string): string {
  return pendingPath(stateRoot, conversationId, generationId);
}

async function syncProjectSpools(
  canonical: string,
  projectsRoot: string,
  attributed: Attribution[],
  conversationId: string,
  generationId: string,
): Promise<void> {
  for (const hit of attributed) {
    const dest = projectSpoolPath(
      path.join(projectsRoot, hit.projectId),
      conversationId,
      generationId,
    );
    if (!fsSync.existsSync(dest) && fsSync.existsSync(canonical)) {
      await copySpool(canonical, dest);
    }
  }
}

async function appendEverywhere(
  record: TrajectoryRecord,
  canonical: string,
  projectsRoot: string,
  attributed: Attribution[],
): Promise<void> {
  await appendJsonl(canonical, record);
  for (const hit of attributed) {
    const dest = projectSpoolPath(
      path.join(projectsRoot, hit.projectId),
      record.conversation_id,
      record.generation_id,
    );
    await appendJsonl(dest, record);
  }
}

export async function encryptGeneration(
  conversationId: string,
  generationId: string,
  opts?: RecorderOptions,
): Promise<{ encrypted: string[]; spoolOnly: boolean }> {
  const projectsRoot = projectsRootOf(opts);
  const stateRoot = stateRootOf(opts);
  const state = await loadSession(stateRoot, conversationId);
  const canonical = canonicalSpool(stateRoot, conversationId, generationId);
  const records = await readJsonlRecords(canonical);
  if (records.length === 0) {
    return { encrypted: [], spoolOnly: false };
  }

  const attributed = state.attributed.length > 0 ? state.attributed : records.at(-1)?.attributed ?? [];
  if (attributed.length === 0) {
    return { encrypted: [], spoolOnly: true };
  }

  const header: TurnHeader = {
    v: TRAJECTORY_SCHEMA_VERSION,
    kind: "turn",
    conversation_id: conversationId,
    generation_id: generationId,
    projectIds: [...new Set(attributed.map((a) => a.projectId))],
    branches: attributed,
    encryptedAt: (opts?.now ?? (() => new Date()))().toISOString(),
    eventCount: records.length,
    model: state.model,
    cursor_version: state.cursorVersion,
  };
  const plaintext = `${JSON.stringify(header)}\n${records.map((r) => JSON.stringify(r)).join("\n")}\n`;

  const encrypted: string[] = [];
  let spoolOnly = false;
  const byProject = new Map<string, Attribution[]>();
  for (const hit of attributed) {
    const list = byProject.get(hit.projectId) ?? [];
    list.push(hit);
    byProject.set(hit.projectId, list);
  }

  for (const [projectId, hits] of byProject) {
    const recipients = listRecipients(projectId, opts);
    if (recipients.length === 0) {
      spoolOnly = true;
      continue;
    }
    let ciphertext: Uint8Array;
    try {
      ciphertext = await encryptToRecipients(plaintext, recipients);
    } catch (err) {
      console.error("[cursor-trajectory] encrypt failed", projectId, err);
      spoolOnly = true;
      continue;
    }
    for (const hit of hits) {
      const root = branchRootFor(projectsRoot, hit);
      const dest = path.join(
        root,
        TRAJECTORY_MISC_DIR,
        safeFsId(conversationId),
        `${safeFsId(generationId)}.jsonl.age`,
      );
      await atomicWriteFile(dest, ciphertext);
      encrypted.push(dest);
    }
    await removeFile(projectSpoolPath(path.join(projectsRoot, projectId), conversationId, generationId));
  }

  if (encrypted.length > 0 && !spoolOnly) {
    await removeFile(canonical);
    const gen = state.generations[generationId];
    if (gen) gen.flushed = true;
    await saveSession(stateRoot, state);
  }

  return { encrypted, spoolOnly };
}

async function encryptTranscript(state: SessionState, opts?: RecorderOptions): Promise<string[]> {
  const transcript = state.transcriptPath;
  if (!transcript || !fsSync.existsSync(transcript) || state.attributed.length === 0) return [];
  const buf = await fs.readFile(transcript);
  const encrypted: string[] = [];
  const projectsRoot = projectsRootOf(opts);
  const byProject = new Map<string, Attribution[]>();
  for (const hit of state.attributed) {
    const list = byProject.get(hit.projectId) ?? [];
    list.push(hit);
    byProject.set(hit.projectId, list);
  }
  for (const [projectId, hits] of byProject) {
    const recipients = listRecipients(projectId, opts);
    if (recipients.length === 0) continue;
    let ciphertext: Uint8Array;
    try {
      ciphertext = await encryptToRecipients(buf, recipients);
    } catch {
      continue;
    }
    for (const hit of hits) {
      const dest = path.join(
        branchRootFor(projectsRoot, hit),
        TRAJECTORY_MISC_DIR,
        safeFsId(state.conversationId),
        "transcript.age",
      );
      await atomicWriteFile(dest, ciphertext);
      encrypted.push(dest);
    }
  }
  return encrypted;
}

export async function processHookEvent(
  raw: unknown,
  opts?: RecorderOptions,
): Promise<IngestResult> {
  const payload = asObject(raw);
  if (!payload) return { ingested: false, skipped: "empty", attributed: [] };
  const hook = hookNameOf(payload);
  if (!hook || !isTrackedHook(hook)) {
    return { ingested: false, skipped: "untracked", attributed: [] };
  }

  const projectsRoot = projectsRootOf(opts);
  const stateRoot = stateRootOf(opts);
  const conversationId = conversationIdOf(payload);
  const generationId = generationIdOf(payload, conversationId);
  const now = (opts?.now ?? (() => new Date()))().toISOString();

  return withFileLock(sessionStatePath(stateRoot, conversationId) + ".lock", async () => {
    const state = await loadSession(stateRoot, conversationId);
    state.model = str(payload.model) ?? state.model;
    state.cursorVersion = str(payload.cursor_version) ?? state.cursorVersion;
    const transcript = str(payload.transcript_path) || process.env.CURSOR_TRANSCRIPT_PATH;
    if (transcript) state.transcriptPath = transcript;

    const hits = attributionsFromPayload(payload, projectsRoot);
    state.attributed = unionAttributions(state.attributed, hits);

    const gen = ensureGen(state, generationId);
    const key = dedupKey(hook, payload, generationId);
    let ingested = true;
    if (gen.seen.includes(key)) {
      ingested = false;
    } else {
      gen.seen.push(key);
      if (gen.seen.length > 4000) gen.seen.splice(0, gen.seen.length - 3000);

      const body = {
        hook,
        conversation_id: conversationId,
        generation_id: generationId,
        model: str(payload.model) ?? null,
        model_id: str(payload.model_id) ?? null,
        cursor_version: str(payload.cursor_version) ?? null,
        payload,
      };
      const seq = gen.seq + 1;
      const prevHash = gen.lastHash;
      const record: TrajectoryRecord = {
        v: TRAJECTORY_SCHEMA_VERSION,
        seq,
        prevHash,
        hash: hashRecord(seq, prevHash, body),
        ts: now,
        hook,
        conversation_id: conversationId,
        generation_id: generationId,
        session_id: str(payload.session_id) || conversationId,
        model: body.model,
        model_id: body.model_id,
        cursor_version: body.cursor_version,
        attributed: state.attributed,
        payload,
      };
      gen.seq = seq;
      gen.lastHash = record.hash;
      gen.flushed = false;

      const canonical = canonicalSpool(stateRoot, conversationId, generationId);
      if (state.attributed.length > 0) {
        await syncProjectSpools(canonical, projectsRoot, state.attributed, conversationId, generationId);
        await appendEverywhere(record, canonical, projectsRoot, state.attributed);
      } else {
        await appendJsonl(canonical, record);
      }
    }

    if (hook === "stop") {
      await saveSession(stateRoot, state);
      const result = await encryptGeneration(conversationId, generationId, opts);
      gen.flushed = result.encrypted.length > 0 && !result.spoolOnly;
      await saveSession(stateRoot, state);
      return {
        ingested,
        skipped: ingested ? undefined : "duplicate",
        encrypted: result.encrypted,
        spoolOnly: result.spoolOnly,
        attributed: state.attributed,
      };
    }

    if (hook === "sessionEnd") {
      const encrypted: string[] = [];
      let spoolOnly = false;
      await saveSession(stateRoot, state);
      for (const [genId, g] of Object.entries(state.generations)) {
        if (g.flushed || g.seq === 0) continue;
        const result = await encryptGeneration(conversationId, genId, opts);
        encrypted.push(...result.encrypted);
        spoolOnly = spoolOnly || result.spoolOnly;
      }
      encrypted.push(...(await encryptTranscript(state, opts)));
      await saveSession(stateRoot, state);
      return {
        ingested,
        skipped: ingested ? undefined : "duplicate",
        encrypted,
        spoolOnly,
        attributed: state.attributed,
      };
    }

    await saveSession(stateRoot, state);
    return {
      ingested,
      skipped: ingested ? undefined : "duplicate",
      attributed: state.attributed,
    };
  });
}

export async function ingestHookStdin(raw: string, opts?: RecorderOptions): Promise<IngestResult> {
  const text = raw.trim();
  if (!text) return { ingested: false, skipped: "empty", attributed: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ingested: false, skipped: "empty", attributed: [] };
  }
  return processHookEvent(parsed, opts);
}

export async function decryptTurnFile(filePath: string, identity: string): Promise<{
  header: TurnHeader;
  records: TrajectoryRecord[];
}> {
  const buf = await fs.readFile(filePath);
  const plain = await decryptWithIdentity(new Uint8Array(buf), identity);
  const text = Buffer.from(plain).toString("utf8");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const header = JSON.parse(lines[0] ?? "{}") as TurnHeader;
  const records = lines.slice(1).map((l) => JSON.parse(l) as TrajectoryRecord);
  return { header, records };
}

export function recorderStateRoot(opts?: RecorderOptions): string {
  return stateRootOf(opts);
}

export function recorderProjectsRoot(opts?: RecorderOptions): string {
  return projectsRootOf(opts);
}

export { emptySession, loadSession };
