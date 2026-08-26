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
import { ProjectDiskWatch } from "./diskWatch.js";
import { patchYText, threeWayMerge } from "./textMerge.js";

const FILES_MAP = "files";
const META_MAP = "meta";

/** Keep collab sync responsive — large CSVs/JSON under data/ must not enter the Y.Doc. */
const MAX_COLLAB_FILE_BYTES = 256 * 1024;
const MAX_COLLAB_SNAPSHOT_BYTES = 2 * 1024 * 1024;

/** Path segments that are research artifacts / deps, not the manuscript. */
const COLLAB_SKIP_DIRS = new Set(["data", "private", "tmp", "vendor", "node_modules"]);
/** Build/run logs and aux files — view via REST, never hydrate into the CRDT. */
const COLLAB_NEVER_EXT = new Set([
  ".log",
  ".aux",
  ".out",
  ".toc",
  ".lof",
  ".lot",
  ".nav",
  ".snm",
  ".vrb",
]);
/** Seed these into the room on open so the editor is live without opening every file. */
const EAGER_COLLAB_EXT = new Set([".tex", ".bib", ".sty", ".cls", ".ltx", ".bst", ".md", ".txt"]);

function pathExt(relativePath: string): string {
  return path.extname(relativePath).toLowerCase();
}

function hasSkippedCollabDir(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(0, -1).some((p) => COLLAB_SKIP_DIRS.has(p.toLowerCase()));
}

function isCollabTextFile(projectId: string, relativePath: string): boolean {
  if (!relativePath || relativePath.includes(".openleaf/")) return false;
  if (COLLAB_NEVER_EXT.has(pathExt(relativePath))) return false;
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

/** Hydrate on room open. Other small text files join the CRDT only when opened (ensureFile). */
function isEagerCollabFile(projectId: string, relativePath: string): boolean {
  if (!isCollabTextFile(projectId, relativePath)) return false;
  if (hasSkippedCollabDir(relativePath)) return false;
  const ext = pathExt(relativePath);
  if (EAGER_COLLAB_EXT.has(ext)) return true;
  return !relativePath.includes("/");
}

function flattenCollabTextFiles(
  projectId: string,
  nodes: TreeNode[],
  out: string[] = [],
): string[] {
  for (const n of nodes) {
    if (n.type === "file") {
      if (isEagerCollabFile(projectId, n.path)) out.push(n.path);
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
  /** Last content written to disk or ingested from disk — the 3-way merge base. */
  private diskBaseline = new Map<string, string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private seeding = new Map<string, Promise<Y.Text>>();
  private ready: Promise<void>;
  private destroyed = false;
  private closing = false;
  private readonly flushMutex = createMutex();
  private updateHandler: (update: Uint8Array, origin: unknown) => void;
  private diskWatch: ProjectDiskWatch | null = null;

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
    this.files.observeDeep((events, transaction) => {
      // Disk-origin txns must not mark paths dirty: observers fire *after* the
      // transact, which would undo ingest's dirtyPaths.delete and then a later
      // flushNow would clobber subsequent external writes.
      if (
        transaction.origin === "disk-seed" ||
        transaction.origin === "disk-flush" ||
        transaction.origin === "tree-sync"
      ) {
        return;
      }
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
    void this.ready.then(
      () => {
        this.startDiskWatch();
        // Shrink a previous data/-bloated ydoc.bin after eager-only hydrate.
        void this.persistSnapshot().catch((err) => console.error("[collab] persist failed", err));
      },
      () => undefined,
    );
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

      // If disk changed under us (external write while the path was dirty),
      // merge that in *before* writing CRDT → disk so we never revert it.
      const diskNow = new Map<string, string | null>();
      this.doc.transact(() => {
        for (const filePath of paths) {
          const ytext = this.files.get(filePath);
          if (!ytext) continue;
          const disk = this.readDiskText(filePath);
          diskNow.set(filePath, disk);
          if (disk === null) continue;
          const ours = ytext.toString();
          const base = this.diskBaseline.get(filePath) ?? ours;
          if (disk !== ours && disk !== base) {
            this.mergeDiskIntoYText(filePath, disk);
          }
        }
      }, "disk-seed");

      for (const filePath of paths) {
        const ytext = this.files.get(filePath);
        if (!ytext) continue;
        const content = ytext.toString();
        const disk = diskNow.has(filePath) ? diskNow.get(filePath)! : this.readDiskText(filePath);
        if (disk === content) {
          this.diskBaseline.set(filePath, content);
          continue;
        }
        try {
          await writeFile(this.projectId, filePath, content, "utf8");
          this.diskBaseline.set(filePath, content);
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
    const eager = flattenCollabTextFiles(this.projectId, tree);
    const keep = new Set(eager);
    this.files.forEach((_t, p) => {
      if (isCollabTextFile(this.projectId, p)) keep.add(p);
    });

    this.doc.transact(() => {
      const stale: string[] = [];
      this.files.forEach((_t, p) => {
        if (!keep.has(p)) stale.push(p);
      });
      for (const p of stale) {
        this.files.delete(p);
        this.diskBaseline.delete(p);
      }

      for (const filePath of keep) {
        this.applyDiskContent(filePath);
      }
      this.meta.set("treeVersion", Date.now());
      this.meta.set("treeEvent", { type: "tree-changed", op: "bump", at: Date.now() });
    }, "disk-seed");
    this.dirtyPaths.clear();
  }

  /**
   * Apply external working-tree edits to the live CRDT.
   * Unflushed editor edits are 3-way merged with disk (disk wins on overlap).
   * No-ops when disk already matches Y.Text (our own flush echo).
   */
  async ingestDiskPaths(relativePaths: string[]): Promise<void> {
    return this.flushMutex.run(async () => {
      await this.whenReady();
      if (this.destroyed || relativePaths.length === 0) return;

      const unique = [...new Set(relativePaths.filter((p) => p && !p.includes("\0")))];
      const treeChanged: string[] = [];
      let commentsChanged = false;
      let mergedDirty = false;

      this.doc.transact(() => {
        for (const filePath of unique) {
          if (filePath.split("/").some((p) => p === ".git" || p === ".openleaf" || p === "node_modules")) {
            continue;
          }
          let full: string;
          try {
            full = resolveProjectPath(this.projectId, filePath);
          } catch {
            continue;
          }

          let st: fsSync.Stats | null = null;
          try {
            st = fsSync.statSync(full);
          } catch {
            st = null;
          }

          if (!st) {
            const ytext = this.files.get(filePath);
            const ours = ytext?.toString() ?? "";
            const base = this.diskBaseline.get(filePath) ?? ours;
            // Real unflushed editor edits keep the CRDT path; flush can recreate.
            if (this.dirtyPaths.has(filePath) && ours !== base) continue;
            if (this.files.has(filePath) || this.hasPathPrefix(filePath)) {
              this.removePathPrefix(filePath);
              treeChanged.push(filePath);
            }
            continue;
          }
          if (st.isDirectory()) {
            treeChanged.push(filePath);
            continue;
          }
          if (filePath === "comments.json") commentsChanged = true;

          if (!isCollabTextFile(this.projectId, filePath)) {
            if (this.files.has(filePath)) {
              this.files.delete(filePath);
              this.dirtyPaths.delete(filePath);
              this.diskBaseline.delete(filePath);
            }
            treeChanged.push(filePath);
            continue;
          }

          const existing = this.files.get(filePath);
          if (!existing && !isEagerCollabFile(this.projectId, filePath)) {
            treeChanged.push(filePath);
            continue;
          }

          let content = "";
          try {
            content = fsSync.readFileSync(full, "utf8");
          } catch {
            continue;
          }
          if (existing && existing.toString() === content) {
            this.diskBaseline.set(filePath, content);
            continue;
          }

          const ours = existing?.toString() ?? "";
          const base = this.diskBaseline.get(filePath) ?? ours;
          const editorDirty = this.dirtyPaths.has(filePath) && ours !== base;
          if (editorDirty) {
            this.mergeDiskIntoYText(filePath, content);
            mergedDirty = true;
            continue;
          }

          const isNew = !existing;
          this.applyDiskContent(filePath, content);
          this.dirtyPaths.delete(filePath);
          if (isNew) treeChanged.push(filePath);
        }

        if (treeChanged.length > 0) {
          this.meta.set("treeVersion", Date.now());
          this.meta.set("treeEvent", {
            type: "tree-changed",
            op: "bump",
            paths: treeChanged,
            at: Date.now(),
          });
        }
        if (commentsChanged) {
          this.meta.set("commentsVersion", Date.now());
        }
      }, "disk-seed");

      if (mergedDirty) this.scheduleFlush();
    });
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
      this.diskBaseline.delete(relativePath);
      return;
    }
    this.doc.transact(() => {
      this.applyDiskContent(relativePath);
      this.meta.set("treeVersion", Date.now());
    }, "disk-seed");
    this.dirtyPaths.delete(relativePath);
  }

  private readDiskText(filePath: string): string | null {
    try {
      return fsSync.readFileSync(resolveProjectPath(this.projectId, filePath), "utf8");
    } catch {
      return null;
    }
  }

  /** Force Y.Text = disk (hydrate, REST write, non-dirty ingest). */
  private applyDiskContent(filePath: string, content?: string): void {
    const next = content ?? this.readDiskText(filePath) ?? "";
    const existing = this.files.get(filePath);
    if (existing) {
      patchYText(existing, next);
    } else {
      const ytext = new Y.Text();
      if (next) ytext.insert(0, next);
      this.files.set(filePath, ytext);
    }
    this.diskBaseline.set(filePath, next);
  }

  /**
   * Fold an external disk snapshot into a possibly editor-dirty Y.Text.
   * Baseline becomes `diskContent` so a later flush writes the merge instead
   * of 3-way-merging against the merged string and dropping editor edits.
   */
  private mergeDiskIntoYText(filePath: string, diskContent: string): void {
    const ytext = this.files.get(filePath);
    if (!ytext) {
      this.applyDiskContent(filePath, diskContent);
      return;
    }
    const ours = ytext.toString();
    const base = this.diskBaseline.get(filePath) ?? ours;
    const merged = threeWayMerge(base, ours, diskContent);
    patchYText(ytext, merged);
    this.diskBaseline.set(filePath, diskContent);
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
      for (const p of stale) {
        this.files.delete(p);
        this.diskBaseline.delete(p);
      }

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
        if (isEagerCollabFile(this.projectId, event.path) || this.files.has(event.path)) {
          this.applyDiskContent(event.path);
        }
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

  private startDiskWatch(): void {
    if (this.destroyed || this.closing || this.diskWatch) return;
    this.diskWatch = new ProjectDiskWatch(this.projectId, projectDir(this.projectId), (paths) => {
      void this.ingestDiskPaths(paths).catch((err) =>
        console.error("[collab] disk ingest failed", err),
      );
    });
    this.diskWatch.start();
  }

  private hasPathPrefix(prefix: string): boolean {
    let found = false;
    this.files.forEach((_t, p) => {
      if (p === prefix || p.startsWith(prefix + "/")) found = true;
    });
    return found;
  }

  private removePathPrefix(prefix: string): void {
    const toDelete: string[] = [];
    this.files.forEach((_t, p) => {
      if (p === prefix || p.startsWith(prefix + "/")) toDelete.push(p);
    });
    for (const p of toDelete) {
      this.files.delete(p);
      this.dirtyPaths.delete(p);
      this.diskBaseline.delete(p);
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
      const baseline = this.diskBaseline.get(m.from);
      this.diskBaseline.delete(m.from);
      // Keep the same Y.Text instance so live bindings / CRDT history survive
      this.files.set(m.to, m.ytext);
      this.dirtyPaths.add(m.to);
      if (baseline !== undefined) this.diskBaseline.set(m.to, baseline);
    }
    this.scheduleFlush();
  }

  async destroy(): Promise<void> {
    if (this.destroyed || this.closing) return;
    this.closing = true;
    this.diskWatch?.stop();
    this.diskWatch = null;
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
