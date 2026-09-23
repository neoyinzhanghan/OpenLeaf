/**
 * Derived FTS5 search index over papers/<citekey>/record.json.
 * Rebuild from record.json if missing/stale — never treat as source of truth.
 *
 * The DB handle is a process singleton. Rebuilds (or tests) may unlink and
 * recreate index.sqlite while we still hold the old inode; writes then fail
 * with "attempt to write a readonly database". Detect inode churn and reopen.
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { PaperRecord } from "./types.js";
import { cacheDir, indexDbPath } from "./paths.js";

let db: DatabaseSync | null = null;
/** Inode of the file `db` was opened against; null when closed. */
let dbInode: number | null = null;

function isSqliteReadonlyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /readonly database|SQLITE_READONLY|database is locked/i.test(msg);
}

function currentInode(path: string): number | null {
  try {
    return fs.statSync(path).ino;
  } catch {
    return null;
  }
}

function openDb(): DatabaseSync {
  const path = indexDbPath();
  const ino = currentInode(path);
  if (db && dbInode != null && ino === dbInode) return db;

  // File missing, replaced, or first open — drop any stale handle.
  if (db) closeIndexDb();

  fs.mkdirSync(cacheDir(), { recursive: true });
  db = new DatabaseSync(path);
  dbInode = currentInode(path);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
      citekey UNINDEXED,
      title,
      authors,
      abstract,
      venue,
      tags,
      notes,
      year UNINDEXED,
      tokenize = 'porter unicode61'
    );
  `);
  return db;
}

export function closeIndexDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      // Ignore double-close / already-invalid handles after an unlink.
    }
    db = null;
    dbInode = null;
  }
}

function withDb<T>(fn: (database: DatabaseSync) => T): T {
  try {
    return fn(openDb());
  } catch (err) {
    if (!isSqliteReadonlyError(err)) throw err;
    closeIndexDb();
    return fn(openDb());
  }
}

function authorsText(record: PaperRecord): string {
  return record.authors.map((a) => `${a.given} ${a.family}`.trim()).join("; ");
}

function tagsText(record: PaperRecord): string {
  return record.tags.join(" ");
}

export function upsertPaperInIndex(record: PaperRecord): void {
  withDb((database) => {
    database.prepare("DELETE FROM papers_fts WHERE citekey = ?").run(record.citekey);
    database
      .prepare(
        `INSERT INTO papers_fts (citekey, title, authors, abstract, venue, tags, notes, year)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.citekey,
        record.title,
        authorsText(record),
        record.abstract,
        record.venue,
        tagsText(record),
        record.notes,
        record.year == null ? "" : String(record.year),
      );
  });
}

export function removePaperFromIndex(citekey: string): void {
  withDb((database) => {
    database.prepare("DELETE FROM papers_fts WHERE citekey = ?").run(citekey);
  });
}

/** Wipe and rebuild the FTS table from the given records. */
export function rebuildIndex(records: PaperRecord[]): void {
  closeIndexDb();
  const p = indexDbPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const database = openDb();
  const insert = database.prepare(
    `INSERT INTO papers_fts (citekey, title, authors, abstract, venue, tags, notes, year)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  database.exec("BEGIN");
  try {
    for (const record of records) {
      insert.run(
        record.citekey,
        record.title,
        authorsText(record),
        record.abstract,
        record.venue,
        tagsText(record),
        record.notes,
        record.year == null ? "" : String(record.year),
      );
    }
    database.exec("COMMIT");
  } catch (err) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Full-text search. Returns matching citekeys ordered by FTS rank.
 * Empty query returns null (caller should fall back to listing all).
 */
export function searchIndex(query: string, limit = 50): string[] | null {
  const q = query.trim();
  if (!q) return null;
  // Escape FTS5 special chars by wrapping each token in quotes for prefix match.
  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, ""))
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const ftsQuery = tokens.map((t) => `"${t}"*`).join(" ");
  try {
    return withDb((database) => {
      const rows = database
        .prepare(
          `SELECT citekey FROM papers_fts WHERE papers_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(ftsQuery, limit) as Array<{ citekey: string }>;
      return rows.map((r) => r.citekey);
    });
  } catch {
    // Malformed FTS query → treat as no matches rather than crashing.
    return [];
  }
}
