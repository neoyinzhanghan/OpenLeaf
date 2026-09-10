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
import { ensureBranchRoot } from "../timeline.js";
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

function isCollabTextFile(rootDir: string, relativePath: string): boolean {
  if (!relativePath || relativePath.includes(".openleaf/")) return false;
  if (COLLAB_NEVER_EXT.has(pathExt(relativePath))) return false;
  let full: string;
  try {
    full = resolveInRoot(rootDir, relativePath);
  } catch {
    return false;
  }
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
function isEagerCollabFile(rootDir: string, relativePath: string): boolean {
  if (!isCollabTextFile(rootDir, relativePath)) return false;
  if (hasSkippedCollabDir(relativePath)) return false;
  const ext = pathExt(relativePath);
  if (EAGER_COLLAB_EXT.has(ext)) return true;
  return !relativePath.includes("/");
}

function flattenCollabTextFiles(
  rootDir: string,
  nodes: TreeNode[],
  out: string[] = [],
): string[] {
  for (const n of nodes) {
    if (n.type === "file") {
      if (isEagerCollabFile(rootDir, n.path)) out.push(n.path);
    } else if (n.children) {
      flattenCollabTextFiles(rootDir, n.children, out);
    }
  }
  return out;
}

export function roomKey(projectId: string, branchId = "main"): string {
  return `${projectId}::${branchId}`;
}

export function snapshotPath(projectId: string, branchId = "main"): string {
  return path.join(projectDir(projectId), ".openleaf", "collab", branchId, "ydoc.bin");
}

export async function clearCollabSnapshot(projectId: string, branchId = "main"): Promise<void> {
  const dest = snapshotPath(projectId, branchId);
  try {
    await fs.unlink(dest);
  } catch {
    /* missing is fine */
  }
}

function resolveInRoot(rootDir: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.split("/").some((p) => p === "..")) {
    throw Object.assign(new Error("Path escape"), { status: 400 });
  }
  const full = path.resolve(rootDir, normalized);
  if (!full.startsWith(rootDir + path.sep) && full !== rootDir) {
    throw Object.assign(new Error("Path escape"), { status: 400 });
  }
  return full;
}

async function writeInRoot(rootDir: string, relativePath: string, content: string): Promise<void> {
  const full = resolveInRoot(rootDir, relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
}

async function getTreeFromRoot(rootDir: string): Promise<TreeNode[]> {
  // Reuse project tree builder via a fake walk — call build through getTree only for main.
  // Minimal recursive listing:
  async function walk(dir: string, prefix: string): Promise<TreeNode[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const nodes: TreeNode[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git" || entry.name === ".openleaf" || entry.name === "node_modules") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        nodes.push({ name: entry.name, path: rel, type: "directory", children: await walk(path.join(dir, entry.name), rel) });
      } else {
        nodes.push({ name: entry.name, path: rel, type: "file" });
      }
    }
    return nodes;
  }
  return walk(rootDir, "");
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
  readonly branchId: string;
  readonly rootDir: string;
  readonly key: string;
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

  constructor(projectId: string, branchId: string, rootDir: string, generation: number) {
    this.projectId = projectId;
    this.branchId = branchId;
    this.rootDir = rootDir;
    this.key = roomKey(projectId, branchId);
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

  get isDead(): boolean {
    return this.destroyed || this.closing;
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
      if (this.destroyed || this.closing) return null;
      if (isBranchRoomSealed(this.projectId, this.branchId)) return null;
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
          await writeInRoot(this.rootDir, filePath, content);
          this.diskBaseline.set(filePath, content);
        } catch (err) {
          this.dirtyPaths.add(filePath);
          throw err;
        }
      }
      this.doc.transact(() => {
        this.meta.set("flushAt", Date.now());
      }, "disk-flush");

      try {
        bumpProjectLeavesVersion(this.projectId);
      } catch {
        /* ignore */
      }

      // Autosave flushes to the working copy only. Intentional commits use the timeline API.
      if (paths.length === 0 || opts?.commit !== true) return null;
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
    const tree = await getTreeFromRoot(this.rootDir);
    const eager = flattenCollabTextFiles(this.rootDir, tree);
    const keep = new Set(eager);
    this.files.forEach((_t, p) => {
      if (isCollabTextFile(this.rootDir, p)) keep.add(p);
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
      if (this.destroyed || this.closing || relativePaths.length === 0) return;
      if (isBranchRoomSealed(this.projectId, this.branchId)) return;

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
            full = resolveInRoot(this.rootDir, filePath);
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

          if (!isCollabTextFile(this.rootDir, filePath)) {
            if (this.files.has(filePath)) {
              this.files.delete(filePath);
              this.dirtyPaths.delete(filePath);
              this.diskBaseline.delete(filePath);
            }
            treeChanged.push(filePath);
            continue;
          }

          const existing = this.files.get(filePath);
          if (!existing && !isEagerCollabFile(this.rootDir, filePath)) {
            treeChanged.push(filePath);
            continue;
          }

          const diskText = this.readDiskText(filePath);
          if (diskText === null) continue;
          const content = diskText;
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
    if (!isCollabTextFile(this.rootDir, relativePath)) {
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
      // Normalize to LF so Y.Text indices match Monaco when guests are on Windows.
      return fsSync
        .readFileSync(resolveInRoot(this.rootDir, filePath), "utf8")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
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
    if (this.destroyed || this.closing) return;
    if (isBranchRoomSealed(this.projectId, this.branchId)) return;
    const dest = snapshotPath(this.projectId, this.branchId);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const update = Y.encodeStateAsUpdate(this.doc);
    await fs.writeFile(dest, Buffer.from(update));
  }

  private async hydrate(): Promise<void> {
    // Optional CRDT snapshot for reconnect speed, then always reconcile from disk
    // so git restores / external writes win over a stale ydoc.bin.
    const snap = snapshotPath(this.projectId, this.branchId);
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

    const tree = await getTreeFromRoot(this.rootDir);
    const textPaths = flattenCollabTextFiles(this.rootDir, tree);
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

      if (!isCollabTextFile(this.rootDir, relativePath)) {
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
        if (isEagerCollabFile(this.rootDir, event.path) || this.files.has(event.path)) {
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

  /** Cross-branch leaf +/- refresh signal (all share links in this project). */
  bumpLeavesVersion(version = Date.now()): void {
    this.doc.transact(() => {
      this.meta.set("leavesVersion", version);
    }, "leaves");
  }

  private startDiskWatch(): void {
    if (this.destroyed || this.closing || this.diskWatch) return;
    this.diskWatch = new ProjectDiskWatch(this.projectId, this.rootDir, (paths) => {
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

  /** Close all tracked clients (WebSockets). Safe if clients are plain stubs in tests. */
  kickClients(): void {
    for (const client of [...this.clients]) {
      try {
        const ws = client as { close?: () => void; readyState?: number };
        if (typeof ws.close === "function") ws.close();
      } catch {
        /* ignore */
      }
      this.clients.delete(client);
    }
  }

  async destroy(opts?: { skipFlush?: boolean }): Promise<void> {
    if (this.destroyed || this.closing) return;
    this.closing = true;
    this.kickClients();
    this.diskWatch?.stop();
    this.diskWatch = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.flushTimer = null;
    this.persistTimer = null;
    if (!opts?.skipFlush) {
      try {
        // Flush while still the active room and not yet marked destroyed
        if (rooms.get(this.key) === this) {
          await this.flushNow({ commit: false });
          await this.persistSnapshot();
        }
      } catch (err) {
        console.error("[collab] destroy flush failed", err);
      }
    }
    this.destroyed = true;
    this.doc.off("update", this.updateHandler);
    this.doc.destroy();
  }
}

const rooms = new Map<string, ProjectRoom>();
const roomCreating = new Map<string, Promise<ProjectRoom>>();
let generationCounter = 0;

/** Tips sealed during prune/delete — blocks new collab rooms and disk flushes. */
const sealedBranchKeys = new Set<string>();

export function sealBranchRoom(projectId: string, branchId: string): void {
  sealedBranchKeys.add(roomKey(projectId, branchId));
}

export function unsealBranchRoom(projectId: string, branchId: string): void {
  sealedBranchKeys.delete(roomKey(projectId, branchId));
}

export function isBranchRoomSealed(projectId: string, branchId: string): boolean {
  return sealedBranchKeys.has(roomKey(projectId, branchId));
}

export function isRoomCreating(projectId: string, branchId: string): boolean {
  return roomCreating.has(roomKey(projectId, branchId));
}

/** Wait for an in-flight getOrCreateRoom to settle (success or failure). */
export async function awaitRoomCreating(projectId: string, branchId: string): Promise<void> {
  const pending = roomCreating.get(roomKey(projectId, branchId));
  if (!pending) return;
  try {
    await pending;
  } catch {
    /* create failed — fine */
  }
}

export function getRoom(projectId: string, branchId = "main"): ProjectRoom | undefined {
  return rooms.get(roomKey(projectId, branchId));
}

/** All live rooms for a project (any branch). */
export function getProjectRooms(projectId: string): ProjectRoom[] {
  const prefix = `${projectId}::`;
  return [...rooms.values()].filter((r) => r.key.startsWith(prefix));
}

export async function getOrCreateRoom(
  projectId: string,
  branchId = "main",
): Promise<ProjectRoom> {
  const key = roomKey(projectId, branchId);
  if (isBranchRoomSealed(projectId, branchId)) {
    throw Object.assign(new Error("This tip was pruned and cannot be opened"), { status: 410 });
  }

  const existing = rooms.get(key);
  if (existing) {
    if (existing.isDead) {
      rooms.delete(key);
    } else {
      // Refuse stale rooms on pruned tips (existing path skips ensureBranchRoot).
      try {
        const { loadTimeline, getBranch, isBranchPruned } = await import("../timeline.js");
        const state = await loadTimeline(projectId);
        const branch = getBranch(state, branchId);
        if (isBranchPruned(branch)) {
          await forceDestroyBranchRoom(projectId, branchId, { skipFlush: true });
          throw Object.assign(new Error(`Branch “${branch.name}” was pruned and cannot be opened`), {
            status: 410,
          });
        }
      } catch (e) {
        if (e && typeof e === "object" && "status" in e) throw e;
        throw e;
      }
      await existing.whenReady();
      return existing;
    }
  }

  let creating = roomCreating.get(key);
  if (!creating) {
    creating = (async () => {
      if (isBranchRoomSealed(projectId, branchId)) {
        throw Object.assign(new Error("This tip was pruned and cannot be opened"), { status: 410 });
      }
      const dir = projectDir(projectId);
      if (!fsSync.existsSync(dir)) {
        throw Object.assign(new Error("Project not found"), { status: 404 });
      }
      const rootDir = await ensureBranchRoot(projectId, branchId);
      if (isBranchRoomSealed(projectId, branchId)) {
        throw Object.assign(new Error("This tip was pruned and cannot be opened"), { status: 410 });
      }
      const gen = ++generationCounter;
      const room = new ProjectRoom(projectId, branchId, rootDir, gen);
      try {
        await room.whenReady();
      } catch (err) {
        roomCreating.delete(key);
        throw err;
      }
      if (isBranchRoomSealed(projectId, branchId)) {
        await room.destroy({ skipFlush: true });
        roomCreating.delete(key);
        throw Object.assign(new Error("This tip was pruned and cannot be opened"), { status: 410 });
      }
      const raced = rooms.get(key);
      if (raced && raced !== room) {
        await room.destroy({ skipFlush: true });
        return raced;
      }
      rooms.set(key, room);
      roomCreating.delete(key);
      return room;
    })();
    roomCreating.set(key, creating);
  }
  return creating;
}

export async function flushProjectRoom(
  projectId: string,
  opts?: { author?: GitAuthor; message?: string; commit?: boolean; branchId?: string },
): Promise<GitCommitResult | null> {
  const branchId = opts?.branchId ?? "main";
  const room = rooms.get(roomKey(projectId, branchId));
  if (room) return room.flushNow({ ...opts, commit: opts?.commit === true });
  // No live room: disk-only flush never auto-commits anymore.
  return null;
}

export async function reseedProjectRoom(projectId: string, branchId = "main"): Promise<void> {
  const room = rooms.get(roomKey(projectId, branchId));
  if (room) await room.reseedFromDisk();
}

export function notifyProjectTreeChange(
  projectId: string,
  event: Omit<TreeChangeEvent, "type">,
  branchId?: string,
): void {
  if (branchId) {
    rooms.get(roomKey(projectId, branchId))?.notifyTreeChange(event);
    return;
  }
  for (const room of getProjectRooms(projectId)) room.notifyTreeChange(event);
}

export function notifyProjectCommentsChanged(projectId: string, branchId?: string): void {
  if (branchId) {
    rooms.get(roomKey(projectId, branchId))?.bumpCommentsVersion();
    return;
  }
  for (const room of getProjectRooms(projectId)) room.bumpCommentsVersion();
}

/** Fan-out so every live room refreshes cross-branch leaf +/- stats. */
export function bumpProjectLeavesVersion(projectId: string): void {
  const v = Date.now();
  for (const room of getProjectRooms(projectId)) room.bumpLeavesVersion(v);
}

export async function releaseRoomIfEmpty(projectId: string, branchId = "main"): Promise<void> {
  const key = roomKey(projectId, branchId);
  const room = rooms.get(key);
  if (!room || room.clientCount > 0) return;
  roomCreating.delete(key);
  try {
    await room.destroy();
  } finally {
    if (rooms.get(key) === room) {
      rooms.delete(key);
    }
  }
}

/**
 * Force-teardown a branch room for prune/delete: wait for in-flight create, kick clients,
 * skip disk flush (tip is sealed/pruned), clear snapshot.
 */
export async function forceDestroyBranchRoom(
  projectId: string,
  branchId: string,
  opts?: { skipFlush?: boolean },
): Promise<void> {
  const key = roomKey(projectId, branchId);
  sealBranchRoom(projectId, branchId);
  await awaitRoomCreating(projectId, branchId);
  const room = rooms.get(key);
  roomCreating.delete(key);
  if (room) {
    try {
      await room.destroy({ skipFlush: opts?.skipFlush !== false });
    } finally {
      if (rooms.get(key) === room) rooms.delete(key);
    }
  }
  await clearCollabSnapshot(projectId, branchId);
}
