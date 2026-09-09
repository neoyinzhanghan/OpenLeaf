import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import * as Y from "yjs";
import { loadConfig } from "../../config.js";
import { autoCommitProject, type GitAuthor, type GitCommitResult } from "../projectGit.js";
import {
  getTree,
  isTextPath,
  projectDir,
  resolveProjectPath,
  writeFile,
  type TreeNode,
} from "../projectFs.js";

const FILES_MAP = "files";
const META_MAP = "meta";

/** Keep collab sync responsive — large CSVs/JSON under data/ must not enter the Y.Doc. */
const MAX_COLLAB_FILE_BYTES = 256 * 1024;
const MAX_COLLAB_SNAPSHOT_BYTES = 2 * 1024 * 1024;

function isCollabTextFile(projectId: string, relativePath: string): boolean {
  if (!relativePath || relativePath.includes(".openleaf/")) return false;
  const full = resolveProjectPath(projectId, relativePath);
  if (!isTextPath(relativePath) && !isTextPath(full)) return false;
  try {
    const st = fsSync.statSync(full);
    if (st.size > MAX_COLLAB_FILE_BYTES) return false;
  } catch {
    return false;
  }
  return true;
}

function flattenCollabTextFiles(
  projectId: string,
  nodes: TreeNode[],
  out: string[] = [],
): string[] {
  for (const n of nodes) {
    if (n.type === "file") {
      if (isCollabTextFile(projectId, n.path)) out.push(n.path);
    } else if (n.children) {
      flattenCollabTextFiles(projectId, n.children, out);
    }
  }
  return out;
}

export function snapshotPath(projectId: string): string {
  return path.join(projectDir(projectId), ".openleaf", "collab", "ydoc.bin");
}

export async function clearCollabSnapshot(projectId: string): Promise<void> {
  const dest = snapshotPath(projectId);
  try {
    await fs.unlink(dest);
  } catch {
    /* missing is fine */
  }
}

export type TreeChangeEvent = {
  type: "tree-changed";
  op: "create" | "mkdir" | "delete" | "rename" | "write" | "bump";
  path?: string;
  from?: string;
  to?: string;
};

type Mutex = {
  run<T>(fn: () => Promise<T>): Promise<T>;
};

function createMutex(): Mutex {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const next = tail.then(fn, fn);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}

export class ProjectRoom {
  readonly projectId: string;
  readonly doc: Y.Doc;
  readonly files: Y.Map<Y.Text>;
  readonly meta: Y.Map<unknown>;
  readonly generation: number;
  private clients = new Set<unknown>();
  private dirtyPaths = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private seeding = new Map<string, Promise<Y.Text>>();
  private ready: Promise<void>;
  private destroyed = false;
  private readonly flushMutex = createMutex();
  private updateHandler: (update: Uint8Array, origin: unknown) => void;

  constructor(projectId: string, generation: number) {
    this.projectId = projectId;
    this.generation = generation;
    this.doc = new Y.Doc();
    this.files = this.doc.getMap(FILES_MAP);
    this.meta = this.doc.getMap(META_MAP);
    this.updateHandler = (_update, origin) => {
      if (origin === "disk-seed" || origin === "disk-flush" || origin === "tree-sync") return;
      // comments.json lives on disk; only bump meta for live clients
      if (origin === "comments") {
        this.schedulePersist();
        return;
      }
      this.scheduleFlush();
      this.schedulePersist();
    };
    this.doc.on("update", this.updateHandler);
    this.files.observeDeep((events) => {
      for (const event of events) {
        if (event.target === this.files) {
          const mapEvent = event as Y.YMapEvent<Y.Text>;
          for (const key of mapEvent.keysChanged) {
            if (this.files.has(key)) this.dirtyPaths.add(key);
          }
        } else if (event.target instanceof Y.Text) {
          this.files.forEach((text, filePath) => {
            if (text === event.target) this.dirtyPaths.add(filePath);
          });
        }
      }
    });
    this.ready = this.hydrate();
  }

  async whenReady(): Promise<void> {
    await this.ready;
  }

  addClient(client: unknown): void {
    this.clients.add(client);
  }

  removeClient(client: unknown): void {
    this.clients.delete(client);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private scheduleFlush(): void {
    const ms = loadConfig().collab.flushMs;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    // Background disk flush only — commits happen on explicit save / FS mutations
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow({ commit: false }).catch((err) => console.error("[collab] flush failed", err));
    }, ms);
  }

  private schedulePersist(): void {
    if (!loadConfig().collab.persistYjs) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistSnapshot().catch((err) => console.error("[collab] persist failed", err));
    }, Math.max(loadConfig().collab.flushMs, 1000));
  }

  async flushNow(opts?: {
    author?: GitAuthor;
    message?: string;
    commit?: boolean;
  }): Promise<GitCommitResult | null> {
    return this.flushMutex.run(async () => {
      await this.whenReady();
      if (this.destroyed) return null;
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      const paths = [...this.dirtyPaths];
      this.dirtyPaths.clear();
      for (const filePath of paths) {
        const ytext = this.files.get(filePath);
        if (!ytext) continue;
        const content = ytext.toString();
        try {
          await writeFile(this.projectId, filePath, content, "utf8");
        } catch (err) {
          this.dirtyPaths.add(filePath);
          throw err;
        }
      }
      this.doc.transact(() => {
        this.meta.set("flushAt", Date.now());
      }, "disk-flush");

      if (paths.length === 0 || opts?.commit === false) return null;
      const result = await autoCommitProject(this.projectId, {
        author: opts?.author,
        message: opts?.message ?? `Save (${paths.length} file${paths.length === 1 ? "" : "s"})`,
      });
      if (result.committed && result.hash) {
        this.doc.transact(() => {
          this.meta.set("lastCommit", result.hash);
          this.meta.set("lastCommitAt", Date.now());
        }, "disk-flush");
      }
      return result;
    });
  }

  /** Replace all Y.Text contents from disk (e.g. after git restore). */
  async reseedFromDisk(): Promise<void> {
    await this.whenReady();
    const tree = await getTree(this.projectId);
    const textPaths = flattenCollabTextFiles(this.projectId, tree);
    const onDisk = new Set(textPaths);

    this.doc.transact(() => {
      const stale: string[] = [];
      this.files.forEach((_t, p) => {
        if (!onDisk.has(p)) stale.push(p);
      });
      for (const p of stale) this.files.delete(p);

      for (const filePath of textPaths) {
        this.applyDiskContent(filePath);
      }
      this.meta.set("treeVersion", Date.now());
      this.meta.set("treeEvent", { type: "tree-changed", op: "bump", at: Date.now() });
    }, "disk-seed");
    this.dirtyPaths.clear();
  }

  /** Sync one path from disk into the CRDT (used after REST writes). */
  async syncPathFromDisk(relativePath: string): Promise<void> {
    await this.whenReady();
    if (!isCollabTextFile(this.projectId, relativePath)) {
      // Drop oversized / binary paths if a prior snapshot had them
      if (this.files.has(relativePath)) {
        this.doc.transact(() => {
          this.files.delete(relativePath);
        }, "disk-seed");
      }
      this.dirtyPaths.delete(relativePath);
      return;
    }
    this.doc.transact(() => {
      this.applyDiskContent(relativePath);
      this.meta.set("treeVersion", Date.now());
    }, "disk-seed");
    this.dirtyPaths.delete(relativePath);
  }

  private applyDiskContent(filePath: string): void {
    const full = resolveProjectPath(this.projectId, filePath);
    let content = "";
    try {
      // Normalize to LF so Y.Text indices match Monaco when guests are on Windows
      // (Monaco defaults to CRLF there; y-monaco maps offsets 1:1).
      content = fsSync.readFileSync(full, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    } catch {
      content = "";
    }
    const existing = this.files.get(filePath);
    if (existing) {
      const cur = existing.toString();
      if (cur !== content) {
        existing.delete(0, cur.length);
        if (content) existing.insert(0, content);
      }
    } else {
      const ytext = new Y.Text();
      if (content) ytext.insert(0, content);
      this.files.set(filePath, ytext);
    }
  }

  async persistSnapshot(): Promise<void> {
    if (!loadConfig().collab.persistYjs) return;
    await this.whenReady();
    if (this.destroyed) return;
    const dest = snapshotPath(this.projectId);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const update = Y.encodeStateAsUpdate(this.doc);
    await fs.writeFile(dest, Buffer.from(update));
  }

  private async hydrate(): Promise<void> {
    // Optional CRDT snapshot for reconnect speed, then always reconcile from disk
    // so git restores / external writes win over a stale ydoc.bin.
    const snap = snapshotPath(this.projectId);
    if (loadConfig().collab.persistYjs && fsSync.existsSync(snap)) {
      try {
        const st = fsSync.statSync(snap);
        if (st.size > MAX_COLLAB_SNAPSHOT_BYTES) {
          console.warn(
            `[collab] dropping oversized snapshot for ${this.projectId} (${st.size} bytes)`,
          );
          await fs.unlink(snap).catch(() => undefined);
        } else {
          const buf = await fs.readFile(snap);
          Y.applyUpdate(this.doc, new Uint8Array(buf), "disk-seed");
        }
      } catch (err) {
        console.error("[collab] snapshot load failed", err);
      }
    }

    const tree = await getTree(this.projectId);
    const textPaths = flattenCollabTextFiles(this.projectId, tree);
    this.doc.transact(() => {
      for (const filePath of textPaths) {
        this.applyDiskContent(filePath);
      }
      // Drop CRDT-only paths that no longer exist on disk (or exceed collab size)
      const onDisk = new Set(textPaths);
      const stale: string[] = [];
      this.files.forEach((_t, p) => {
        if (!onDisk.has(p)) stale.push(p);
      });
      for (const p of stale) this.files.delete(p);

      if (!this.meta.has("treeVersion")) {
        this.meta.set("treeVersion", Date.now());
      }
    }, "disk-seed");
    this.dirtyPaths.clear();
  }

  async ensureFile(relativePath: string): Promise<Y.Text> {
    await this.whenReady();
    const existing = this.files.get(relativePath);
    if (existing) return existing;

    const pending = this.seeding.get(relativePath);
    if (pending) return pending;

    const work = (async () => {
      const again = this.files.get(relativePath);
      if (again) return again;

      if (!isCollabTextFile(this.projectId, relativePath)) {
        throw Object.assign(new Error("File too large (or not text) for collab editing"), {
          status: 400,
        });
      }
      this.doc.transact(() => {
        this.applyDiskContent(relativePath);
      }, "disk-seed");
      const created = this.files.get(relativePath);
      if (!created) throw Object.assign(new Error("Failed to seed file"), { status: 500 });
      return created;
    })().finally(() => {
      this.seeding.delete(relativePath);
    });

    this.seeding.set(relativePath, work);
    return work;
  }

  notifyTreeChange(event: Omit<TreeChangeEvent, "type">): void {
    this.doc.transact(() => {
      if (event.op === "delete" && event.path) {
        this.removePathPrefix(event.path);
      } else if (event.op === "rename" && event.from && event.to) {
        this.renamePathPrefix(event.from, event.to);
      } else if ((event.op === "create" || event.op === "write") && event.path) {
        if (isCollabTextFile(this.projectId, event.path)) this.applyDiskContent(event.path);
      }
      this.meta.set("treeVersion", Date.now());
      this.meta.set("treeEvent", { ...event, type: "tree-changed", at: Date.now() });
    }, "tree-sync");
    this.schedulePersist();
  }

  /** Notify connected clients that comments.json changed (live panel refresh). */
  bumpCommentsVersion(): void {
    this.doc.transact(() => {
      this.meta.set("commentsVersion", Date.now());
    }, "comments");
  }

  private removePathPrefix(prefix: string): void {
    const toDelete: string[] = [];
    this.files.forEach((_t, p) => {
      if (p === prefix || p.startsWith(prefix + "/")) toDelete.push(p);
    });
    for (const p of toDelete) {
      this.files.delete(p);
      this.dirtyPaths.delete(p);
    }
  }

  private renamePathPrefix(from: string, to: string): void {
    const moves: Array<{ from: string; to: string; ytext: Y.Text }> = [];
    this.files.forEach((ytext, p) => {
      if (p === from || p.startsWith(from + "/")) {
        const next = p === from ? to : to + p.slice(from.length);
        moves.push({ from: p, to: next, ytext });
      }
    });
    for (const m of moves) {
      this.files.delete(m.from);
      this.dirtyPaths.delete(m.from);
      // Keep the same Y.Text instance so live bindings / CRDT history survive
      this.files.set(m.to, m.ytext);
      this.dirtyPaths.add(m.to);
    }
    this.scheduleFlush();
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    try {
      // Flush while still the active room and not yet marked destroyed
      if (rooms.get(this.projectId) === this) {
        await this.flushNow({ commit: false });
        await this.persistSnapshot();
      }
    } catch (err) {
      console.error("[collab] destroy flush failed", err);
    }
    this.destroyed = true;
    this.doc.off("update", this.updateHandler);
    this.doc.destroy();
  }
}

const rooms = new Map<string, ProjectRoom>();
const roomCreating = new Map<string, Promise<ProjectRoom>>();
let generationCounter = 0;

export function getRoom(projectId: string): ProjectRoom | undefined {
  return rooms.get(projectId);
}

export async function getOrCreateRoom(projectId: string): Promise<ProjectRoom> {
  const existing = rooms.get(projectId);
  if (existing) {
    await existing.whenReady();
    return existing;
  }

  let creating = roomCreating.get(projectId);
  if (!creating) {
    creating = (async () => {
      const dir = projectDir(projectId);
      if (!fsSync.existsSync(dir)) {
        throw Object.assign(new Error("Project not found"), { status: 404 });
      }
      const gen = ++generationCounter;
      const room = new ProjectRoom(projectId, gen);
      try {
        await room.whenReady();
      } catch (err) {
        roomCreating.delete(projectId);
        throw err;
      }
      // Another creator may have finished first
      const raced = rooms.get(projectId);
      if (raced && raced !== room) {
        await room.destroy();
        return raced;
      }
      rooms.set(projectId, room);
      roomCreating.delete(projectId);
      return room;
    })();
    roomCreating.set(projectId, creating);
  }
  return creating;
}

export async function flushProjectRoom(
  projectId: string,
  opts?: { author?: GitAuthor; message?: string; commit?: boolean },
): Promise<GitCommitResult | null> {
  const room = rooms.get(projectId);
  if (room) return room.flushNow(opts);
  if (opts?.commit === false) return null;
  return autoCommitProject(projectId, {
    author: opts?.author,
    message: opts?.message,
  });
}

export async function reseedProjectRoom(projectId: string): Promise<void> {
  const room = rooms.get(projectId);
  if (room) await room.reseedFromDisk();
}

export function notifyProjectTreeChange(
  projectId: string,
  event: Omit<TreeChangeEvent, "type">,
): void {
  const room = rooms.get(projectId);
  if (room) room.notifyTreeChange(event);
}

export function notifyProjectCommentsChanged(projectId: string): void {
  const room = rooms.get(projectId);
  if (room) room.bumpCommentsVersion();
}

export async function releaseRoomIfEmpty(projectId: string): Promise<void> {
  const room = rooms.get(projectId);
  if (!room || room.clientCount > 0) return;
  // Keep map entry until destroy finishes so reconnect won't race with flush
  roomCreating.delete(projectId);
  try {
    await room.destroy();
  } finally {
    if (rooms.get(projectId) === room) {
      rooms.delete(projectId);
    }
  }
}
