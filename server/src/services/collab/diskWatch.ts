import fs from "node:fs";
import path from "node:path";
import { isCursorTrajectoryRel } from "../cursorTrajectory/constants.js";

/** Never attach inotify watches here — these trees are huge and not manuscript source. */
const SKIP_DIR_NAMES = new Set([".git", ".openleaf", "node_modules", "cursor-trajectories"]);
/** One watch descriptor per directory; LaTeX projects are tiny, this is a safety rail. */
const MAX_WATCH_DIRS = 512;
const DEBOUNCE_MS = 200;

function isSkippedRel(rel: string): boolean {
  if (isCursorTrajectoryRel(rel)) return true;
  return rel.split("/").some((p) => SKIP_DIR_NAMES.has(p));
}

function isJunkName(name: string): boolean {
  if (!name) return true;
  if (name.endsWith("~") || name.endsWith(".swp") || name.endsWith(".swo")) return true;
  if (name.endsWith(".tmp") || name.endsWith(".temp") || name.endsWith(".bak")) return true;
  if (name.startsWith(".#")) return true;
  if (name.startsWith("#") && name.endsWith("#")) return true;
  if (name.startsWith(".nfs")) return true;
  return false;
}

/**
 * Lightweight disk → CRDT bridge.
 *
 * One `fs.watch` per source directory (inotify on Linux). No recursive descent
 * into `.git` / `.openleaf` / `node_modules`, no stat cache, no file contents
 * held in memory — events are basenames, and the room reads a path only when
 * ingesting a debounced batch.
 */
export class ProjectDiskWatch {
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private capWarned = false;

  constructor(
    private readonly projectId: string,
    private readonly root: string,
    private readonly onBatch: (relativePaths: string[]) => void,
  ) {}

  start(): void {
    this.watchTree(this.root);
    console.log(
      `[collab] disk watch ${this.projectId}: ${this.watchers.size} dir${this.watchers.size === 1 ? "" : "s"}`,
    );
  }

  stop(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
    }
    this.watchers.clear();
  }

  private watchTree(dir: string): void {
    this.watchDir(dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIR_NAMES.has(entry.name)) continue;
      this.watchTree(path.join(dir, entry.name));
    }
  }

  private watchDir(dir: string): void {
    if (this.closed || this.watchers.has(dir)) return;
    if (this.watchers.size >= MAX_WATCH_DIRS) {
      if (!this.capWarned) {
        this.capWarned = true;
        console.warn(
          `[collab] disk watch cap (${MAX_WATCH_DIRS} dirs) reached for ${this.projectId}; deeper folders are skipped`,
        );
      }
      return;
    }
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, { persistent: true, encoding: "utf8" }, (_event, filename) => {
        this.onFsEvent(dir, filename);
      });
    } catch (err) {
      console.error(`[collab] disk watch failed for ${dir}`, err);
      return;
    }
    watcher.on("error", (err) => {
      console.error(`[collab] disk watch error ${this.projectId}`, err);
    });
    this.watchers.set(dir, watcher);
  }

  private onFsEvent(dir: string, filename: string | Buffer | null): void {
    if (this.closed || !filename) return;
    const name = typeof filename === "string" ? filename : filename.toString();
    if (isJunkName(name) || SKIP_DIR_NAMES.has(name)) return;

    const full = path.join(dir, name);
    const rel = path.relative(this.root, full).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..") || isSkippedRel(rel)) return;

    try {
      const st = fs.statSync(full);
      if (st.isDirectory()) this.watchDir(full);
    } catch {
      const nested = this.watchers.get(full);
      if (nested) {
        try {
          nested.close();
        } catch {
          /* ignore */
        }
        this.watchers.delete(full);
      }
    }

    this.pending.add(rel);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.closed) return;
      const batch = [...this.pending];
      this.pending.clear();
      if (batch.length > 0) this.onBatch(batch);
    }, DEBOUNCE_MS);
  }
}
