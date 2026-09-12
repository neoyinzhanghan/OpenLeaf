import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { TRAJECTORY_SPOOL_DIR } from "./constants.js";
import { atomicWriteFile } from "./encrypt.js";
import { safeFsId } from "./paths.js";
import type { SessionState, TrajectoryRecord } from "./schema.js";

export function sessionStatePath(stateRoot: string, conversationId: string): string {
  return path.join(stateRoot, "sessions", `${safeFsId(conversationId)}.json`);
}

export function pendingPath(stateRoot: string, conversationId: string, generationId: string): string {
  return path.join(stateRoot, "pending", safeFsId(conversationId), `${safeFsId(generationId)}.jsonl`);
}

export function projectSpoolPath(
  projectRoot: string,
  conversationId: string,
  generationId: string,
): string {
  return path.join(
    projectRoot,
    TRAJECTORY_SPOOL_DIR,
    safeFsId(conversationId),
    `${safeFsId(generationId)}.jsonl`,
  );
}

export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const fh = await fs.open(lockPath, "wx");
      try {
        return await fn();
      } finally {
        await fh.close().catch(() => undefined);
        await fs.unlink(lockPath).catch(() => undefined);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  throw new Error("cursor-trajectory lock timeout");
}

export function emptySession(conversationId: string): SessionState {
  return {
    conversationId,
    attributed: [],
    model: null,
    cursorVersion: null,
    transcriptPath: null,
    generations: {},
  };
}

export async function loadSession(stateRoot: string, conversationId: string): Promise<SessionState> {
  const dest = sessionStatePath(stateRoot, conversationId);
  try {
    const raw = JSON.parse(await fs.readFile(dest, "utf8")) as SessionState;
    if (!raw || raw.conversationId !== conversationId) return emptySession(conversationId);
    raw.attributed ??= [];
    raw.generations ??= {};
    return raw;
  } catch {
    return emptySession(conversationId);
  }
}

export async function saveSession(stateRoot: string, state: SessionState): Promise<void> {
  await atomicWriteFile(sessionStatePath(stateRoot, state.conversationId), `${JSON.stringify(state, null, 2)}\n`);
}

export async function appendJsonl(filePath: string, record: TrajectoryRecord): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify(record)}\n`;
  await fs.appendFile(filePath, line, { mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

export async function readJsonlRecords(filePath: string): Promise<TrajectoryRecord[]> {
  if (!fsSync.existsSync(filePath)) return [];
  const text = await fs.readFile(filePath, "utf8");
  const records: TrajectoryRecord[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line) as TrajectoryRecord);
    } catch {
      /* skip corrupt line */
    }
  }
  return records;
}

export async function copySpool(fromPath: string, toPath: string): Promise<void> {
  if (!fsSync.existsSync(fromPath) || path.resolve(fromPath) === path.resolve(toPath)) return;
  if (fsSync.existsSync(toPath)) return;
  await fs.mkdir(path.dirname(toPath), { recursive: true, mode: 0o700 });
  await fs.copyFile(fromPath, toPath);
  await fs.chmod(toPath, 0o600).catch(() => undefined);
}

export async function removeFile(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}
