/**
 * Derived FTS5 search index over papers/<citekey>/record.json.
 * Rebuild from record.json if missing/stale — never treat as source of truth.
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { PaperRecord } from "./types.js";
import { cacheDir, indexDbPath } from "./paths.js";

let db: DatabaseSync | null = null;

function openDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(cacheDir(), { recursive: true });
  db = new DatabaseSync(indexDbPath());
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
    db.close();
    db = null;
  }
}

function authorsText(record: PaperRecord): string {
  return record.authors.map((a) => `${a.given} ${a.family}`.trim()).join("; ");
}

function tagsText(record: PaperRecord): string {
  return record.tags.join(" ");
}

export function upsertPaperInIndex(record: PaperRecord): void {
  const database = openDb();
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
}

export function removePaperFromIndex(citekey: string): void {
  openDb().prepare("DELETE FROM papers_fts WHERE citekey = ?").run(citekey);
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
    database.exec("ROLLBACK");
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
  const database = openDb();
  // Escape FTS5 special chars by wrapping each token in quotes for prefix match.
  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, ""))
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const ftsQuery = tokens.map((t) => `"${t}"*`).join(" ");
  try {
    const rows = database
      .prepare(
        `SELECT citekey FROM papers_fts WHERE papers_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, limit) as Array<{ citekey: string }>;
    return rows.map((r) => r.citekey);
  } catch {
    // Malformed FTS query → treat as no matches rather than crashing.
    return [];
  }
}
