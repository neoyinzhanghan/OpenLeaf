/**
 * Local Kùzu-backed knowledge index.
 *
 * Files remain source of truth (facts.json, .tex, openleaf.json, PDFs).
 * This DB is a derived cache under library/.cache/knowledge.kuzu — same
 * lifecycle as library/.cache/index.sqlite.
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { libraryRoot } from "../library/paths.js";
import type { GraphEdge, GraphNode, KnowledgeGraph } from "./graph.js";

type KuzuDatabase = {
  close: () => Promise<void>;
};
type KuzuConnection = {
  query: (statement: string) => Promise<KuzuQueryResult | KuzuQueryResult[]>;
  close?: () => Promise<void>;
};
type KuzuQueryResult = {
  getAll: () => Promise<Record<string, unknown>[]>;
};
type KuzuModule = {
  Database: new (path: string) => KuzuDatabase;
  Connection: new (db: KuzuDatabase) => KuzuConnection;
};

export type IndexNode = GraphNode & {
  /** Show in default tree (knowledge-cited facts/sources, all kn/projects). */
  inTree: boolean;
  pathRef: string;
  citekey?: string;
  knowledgeId?: string;
  projectId?: string;
  factKey?: string;
  value?: number | null;
  unit?: string;
};

type IndexPayload = {
  stamp: string;
  nodes: IndexNode[];
  edges: GraphEdge[];
  generatedAt: string;
};

let kuzuMod: KuzuModule | null = null;
let db: KuzuDatabase | null = null;
let conn: KuzuConnection | null = null;
let readyStamp: string | null = null;
let memoryFallback: IndexPayload | null = null;
let syncing: Promise<void> | null = null;
/** Serialize all open/close/write against the native Kùzu addon — concurrent use segfaults (exit 139). */
let kuzuGate: Promise<void> = Promise.resolve();

function withKuzuGate<T>(fn: () => Promise<T>): Promise<T> {
  const run = kuzuGate.then(fn, fn);
  kuzuGate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function cacheDir(): string {
  return path.join(libraryRoot(), ".cache");
}

function dbPath(): string {
  return path.join(cacheDir(), "knowledge.kuzu");
}

function stampPath(): string {
  return path.join(cacheDir(), "knowledge.kuzu.stamp");
}

function kuzuEnabled(): boolean {
  // Opt-in: concurrent native open/close during Review polling segfaulted the
  // API (exit 139). Memory payload is complete for tree/neighborhood/search.
  return process.env.OPENLEAF_KNOWLEDGE_KUZU === "1";
}

async function loadKuzu(): Promise<KuzuModule | null> {
  if (!kuzuEnabled()) return null;
  if (kuzuMod) return kuzuMod;
  try {
    const mod = (await import("kuzu")) as unknown as KuzuModule & { default?: KuzuModule };
    kuzuMod = mod.Database ? mod : (mod.default as KuzuModule);
    if (!kuzuMod?.Database || !kuzuMod?.Connection) throw new Error("kuzu exports missing");
    return kuzuMod;
  } catch (err) {
    console.warn("[knowledge-index] kuzu unavailable, using in-memory fallback:", err);
    return null;
  }
}

async function closeDb(): Promise<void> {
  try {
    if (conn) await (conn as { close?: () => Promise<void> }).close?.();
  } catch {
    /* ignore */
  }
  try {
    if (db) await db.close();
  } catch {
    /* ignore */
  }
  conn = null;
  db = null;
  readyStamp = null;
}

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function numOrNull(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "NULL";
  return String(v);
}

async function ensureSchema(c: KuzuConnection): Promise<void> {
  // Fresh DB directory each rebuild — plain CREATE is enough.
  await c.query(`
    CREATE NODE TABLE KnNode(
      id STRING,
      kind STRING,
      name STRING,
      status STRING,
      why STRING,
      collection STRING,
      note STRING,
      inTree BOOLEAN,
      pathRef STRING,
      citekey STRING,
      knowledgeId STRING,
      projectId STRING,
      factKey STRING,
      value DOUBLE,
      unit STRING,
      updatedAt STRING,
      PRIMARY KEY (id)
    );
  `);
  await c.query(`
    CREATE REL TABLE BUILT_ON(
      FROM KnNode TO KnNode,
      flagged BOOLEAN
    );
  `);
}

async function wipeAndOpen(mod: KuzuModule): Promise<KuzuConnection> {
  await closeDb();
  await fsPromises.mkdir(cacheDir(), { recursive: true });
  const dir = dbPath();
  await fsPromises.rm(dir, { recursive: true, force: true });
  db = new mod.Database(dir);
  conn = new mod.Connection(db);
  await ensureSchema(conn);
  return conn;
}

async function writeStamp(stamp: string): Promise<void> {
  await fsPromises.mkdir(cacheDir(), { recursive: true });
  await fsPromises.writeFile(stampPath(), `${stamp}\n`, "utf8");
}

async function readStamp(): Promise<string | null> {
  try {
    return (await fsPromises.readFile(stampPath(), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

export function invalidateKnowledgeIndex(): void {
  readyStamp = null;
  memoryFallback = null;
  try {
    fs.rmSync(stampPath(), { force: true });
  } catch {
    /* ignore */
  }
  // Close on the gate so in-flight kuzu writes finish before unlink/close.
  void withKuzuGate(async () => {
    await closeDb();
  });
}

export async function syncKnowledgeIndex(
  stamp: string,
  build: () => Promise<IndexPayload>,
): Promise<IndexPayload> {
  if (readyStamp === stamp && memoryFallback?.stamp === stamp) {
    return memoryFallback;
  }
  if (syncing) {
    await syncing;
    if (memoryFallback?.stamp === stamp) return memoryFallback;
  }

  syncing = (async () => {
    const payload = await build();
    memoryFallback = payload;
    readyStamp = stamp;

    const mod = await loadKuzu();
    if (!mod) return;

    await withKuzuGate(async () => {
      try {
        const onDisk = await readStamp();
        if (onDisk === stamp && fs.existsSync(dbPath())) {
          if (!conn) {
            db = new mod.Database(dbPath());
            conn = new mod.Connection(db);
          }
          return;
        }

        const c = await wipeAndOpen(mod);
        for (const n of payload.nodes) {
          const why = esc(JSON.stringify(n.why ?? []));
          const q = `
            CREATE (:KnNode {
              id: '${esc(n.id)}',
              kind: '${esc(n.kind)}',
              name: '${esc(n.name)}',
              status: '${esc(n.status)}',
              why: '${why}',
              collection: '${esc(n.collection || "unsorted")}',
              note: '${esc(n.note || "")}',
              inTree: ${n.inTree ? "true" : "false"},
              pathRef: '${esc(n.pathRef)}',
              citekey: '${esc(n.citekey || "")}',
              knowledgeId: '${esc(n.knowledgeId || "")}',
              projectId: '${esc(n.projectId || "")}',
              factKey: '${esc(n.factKey || "")}',
              value: ${numOrNull(n.value ?? null)},
              unit: '${esc(n.unit || "")}',
              updatedAt: '${esc(n.updatedAt || "")}'
            });
          `;
          await c.query(q);
        }
        for (const e of payload.edges) {
          await c.query(`
            MATCH (a:KnNode {id: '${esc(e.from)}'}), (b:KnNode {id: '${esc(e.to)}'})
            CREATE (a)-[:BUILT_ON {flagged: ${e.flagged ? "true" : "false"}}]->(b);
          `);
        }
        await writeStamp(stamp);
      } catch (err) {
        console.warn("[knowledge-index] kuzu sync failed, using memory:", err);
        await closeDb();
      }
    });
  })();

  try {
    await syncing;
  } finally {
    syncing = null;
  }
  return memoryFallback!;
}

function rowToNode(row: Record<string, unknown>): IndexNode {
  let why: string[] = [];
  try {
    why = JSON.parse(String(row.why ?? "[]")) as string[];
  } catch {
    why = [];
  }
  return {
    id: String(row.id),
    kind: String(row.kind) as IndexNode["kind"],
    name: String(row.name),
    status: String(row.status) as IndexNode["status"],
    why,
    collection: String(row.collection || "unsorted"),
    note: String(row.note || "") || undefined,
    inputs: [],
    outputs: [],
    updatedAt: String(row.updatedAt || ""),
    inTree: Boolean(row.inTree),
    pathRef: String(row.pathRef || ""),
    citekey: String(row.citekey || "") || undefined,
    knowledgeId: String(row.knowledgeId || "") || undefined,
    projectId: String(row.projectId || "") || undefined,
    factKey: String(row.factKey || "") || undefined,
    value: row.value == null ? null : Number(row.value),
    unit: String(row.unit || "") || undefined,
  };
}

async function queryAll(c: KuzuConnection, cypher: string): Promise<Record<string, unknown>[]> {
  const result = await c.query(cypher);
  const qr = Array.isArray(result) ? result[0] : result;
  if (!qr) return [];
  return qr.getAll();
}

function attachIo(nodes: IndexNode[], edges: GraphEdge[]): GraphNode[] {
  const byId = new Map(nodes.map((n) => [n.id, { ...n, inputs: [] as string[], outputs: [] as string[] }]));
  for (const e of edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (from) from.outputs.push(e.to);
    if (to) to.inputs.push(e.from);
  }
  return [...byId.values()].map(({ inTree, pathRef, citekey, knowledgeId, projectId, factKey, value, unit, ...rest }) => ({
    ...rest,
    inTree,
    ...(pathRef ? { pathRef } : {}),
    ...(citekey ? { citekey } : {}),
    ...(knowledgeId ? { knowledgeId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(factKey ? { factKey } : {}),
    ...(value != null ? { value } : {}),
    ...(unit ? { unit } : {}),
  }));
}

/** Full indexed graph: in-tree nodes are primary; others are atmosphere (client draws faint). */
export async function queryTreeGraph(): Promise<KnowledgeGraph | null> {
  if (!memoryFallback) return null;
  // Always serve from the in-memory payload. Concurrent native kuzu reads during
  // rebuild have segfaulted the API process (exit 139) under Review-page polling.
  const indexNodes = memoryFallback.nodes;
  const edges = memoryFallback.edges;
  const nodes = attachIo(indexNodes, edges);
  return {
    nodes,
    edges,
    collections: [...new Set(nodes.map((n) => n.collection))].sort(),
    generatedAt: memoryFallback.generatedAt,
  };
}

export async function queryNeighborhood(
  nodeId: string,
  depth: number,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; pathRefs: Record<string, string> } | null> {
  if (!memoryFallback) return null;
  const maxDepth = Math.max(0, Math.min(8, Math.floor(depth)));

  // Memory BFS only — see queryTreeGraph note on kuzu segfaults under concurrent rebuild.
  const adj = new Map<string, string[]>();
  for (const e of memoryFallback.edges) {
    const a = adj.get(e.from) ?? [];
    a.push(e.to);
    adj.set(e.from, a);
    const b = adj.get(e.to) ?? [];
    b.push(e.from);
    adj.set(e.to, b);
  }
  const keep = new Set<string>([nodeId]);
  const q: Array<{ id: string; d: number }> = [{ id: nodeId, d: 0 }];
  while (q.length) {
    const { id, d } = q.shift()!;
    if (d >= maxDepth) continue;
    for (const n of adj.get(id) ?? []) {
      if (keep.has(n)) continue;
      keep.add(n);
      q.push({ id: n, d: d + 1 });
    }
  }
  const citekeys = new Set<string>();
  for (const id of keep) {
    if (id.startsWith("src:")) citekeys.add(id.slice(4));
    const node = memoryFallback.nodes.find((n) => n.id === id);
    if (node?.citekey) citekeys.add(node.citekey);
  }
  for (const n of memoryFallback.nodes) {
    if (n.kind === "fact" && n.citekey && citekeys.has(n.citekey)) keep.add(n.id);
    if (n.kind === "source" && n.citekey && citekeys.has(n.citekey)) keep.add(n.id);
  }
  const indexNodes = memoryFallback.nodes.filter((n) => keep.has(n.id));
  const edges = memoryFallback.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  const nodes = attachIo(indexNodes, edges);
  const pathRefs: Record<string, string> = {};
  for (const n of indexNodes) if (n.pathRef) pathRefs[n.id] = n.pathRef;
  return { nodes, edges, pathRefs };
}

export async function searchIndex(q: string, limit = 40): Promise<IndexNode[]> {
  const needle = q.trim().toLowerCase();
  if (!needle || !memoryFallback) return [];
  return memoryFallback.nodes
    .filter((n) => {
      const hay = `${n.name}\n${n.note || ""}\n${n.factKey || ""}\n${n.knowledgeId || ""}`.toLowerCase();
      return hay.includes(needle);
    })
    .slice(0, limit);
}

export function indexFingerprint(stamp: string): string {
  return createHash("sha256").update(stamp).digest("hex").slice(0, 16);
}

export function getIndexStatus(): {
  backend: "kuzu" | "memory";
  stamp: string | null;
  nodes: number;
  edges: number;
  dbPath: string;
} {
  return {
    backend: conn && readyStamp ? "kuzu" : "memory",
    stamp: readyStamp,
    nodes: memoryFallback?.nodes.length ?? 0,
    edges: memoryFallback?.edges.length ?? 0,
    dbPath: dbPath(),
  };
}
