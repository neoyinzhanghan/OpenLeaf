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

function cacheDir(): string {
  return path.join(libraryRoot(), ".cache");
}

function dbPath(): string {
  return path.join(cacheDir(), "knowledge.kuzu");
}

function stampPath(): string {
  return path.join(cacheDir(), "knowledge.kuzu.stamp");
}

async function loadKuzu(): Promise<KuzuModule | null> {
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
  void closeDb();
  try {
    fs.rmSync(stampPath(), { force: true });
  } catch {
    /* ignore */
  }
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

    const mod = await loadKuzu();
    if (!mod) {
      readyStamp = stamp;
      return;
    }

    try {
      const onDisk = await readStamp();
      if (onDisk === stamp && fs.existsSync(dbPath())) {
        // Re-open existing DB if process restarted with matching stamp.
        if (!conn) {
          db = new mod.Database(dbPath());
          conn = new mod.Connection(db);
        }
        readyStamp = stamp;
        return;
      }

      const c = await wipeAndOpen(mod);
      // Batch inserts — prepared CREATE per node.
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
      readyStamp = stamp;
    } catch (err) {
      console.warn("[knowledge-index] kuzu sync failed, using memory:", err);
      await closeDb();
      readyStamp = stamp;
    }
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
  return [...byId.values()].map(({ inTree: _i, pathRef: _p, citekey: _c, knowledgeId: _k, projectId: _pr, factKey: _f, value: _v, unit: _u, ...rest }) => rest);
}

export async function queryTreeGraph(): Promise<KnowledgeGraph | null> {
  if (!memoryFallback) return null;
  if (conn && readyStamp === memoryFallback.stamp) {
    try {
      const nodeRows = await queryAll(
        conn,
        `MATCH (n:KnNode) WHERE n.inTree = true RETURN n.id AS id, n.kind AS kind, n.name AS name,
          n.status AS status, n.why AS why, n.collection AS collection, n.note AS note,
          n.inTree AS inTree, n.pathRef AS pathRef, n.citekey AS citekey, n.knowledgeId AS knowledgeId,
          n.projectId AS projectId, n.factKey AS factKey, n.value AS value, n.unit AS unit, n.updatedAt AS updatedAt;`,
      );
      const edgeRows = await queryAll(
        conn,
        `MATCH (a:KnNode)-[r:BUILT_ON]->(b:KnNode)
         WHERE a.inTree = true AND b.inTree = true
         RETURN a.id AS from, b.id AS to, r.flagged AS flagged;`,
      );
      const indexNodes = nodeRows.map(rowToNode);
      const edges: GraphEdge[] = edgeRows.map((r) => ({
        from: String(r.from),
        to: String(r.to),
        flagged: Boolean(r.flagged),
      }));
      const nodes = attachIo(indexNodes, edges);
      const collections = [...new Set(nodes.map((n) => n.collection))].sort();
      return {
        nodes,
        edges,
        collections,
        generatedAt: memoryFallback.generatedAt,
      };
    } catch (err) {
      console.warn("[knowledge-index] tree query failed, memory fallback:", err);
    }
  }

  // Memory fallback: filter inTree
  const indexNodes = memoryFallback.nodes.filter((n) => n.inTree);
  const idSet = new Set(indexNodes.map((n) => n.id));
  const edges = memoryFallback.edges.filter((e) => idSet.has(e.from) && idSet.has(e.to));
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

  if (conn && readyStamp === memoryFallback.stamp) {
    try {
      // Variable-length path in Cypher
      const hop = Math.max(1, maxDepth);
      const nodeRows = await queryAll(
        conn,
        `MATCH (seed:KnNode {id: '${esc(nodeId)}'})
         MATCH (seed)-[:BUILT_ON*0..${hop}]-(n:KnNode)
         RETURN DISTINCT n.id AS id, n.kind AS kind, n.name AS name,
           n.status AS status, n.why AS why, n.collection AS collection, n.note AS note,
           n.inTree AS inTree, n.pathRef AS pathRef, n.citekey AS citekey, n.knowledgeId AS knowledgeId,
           n.projectId AS projectId, n.factKey AS factKey, n.value AS value, n.unit AS unit, n.updatedAt AS updatedAt;`,
      );
      // Also pull every fact on sources touched (sibling hydrate from index)
      const citekeys = new Set<string>();
      for (const r of nodeRows) {
        if (String(r.kind) === "source" && r.citekey) citekeys.add(String(r.citekey));
        if (String(r.id).startsWith("src:")) citekeys.add(String(r.id).slice(4));
      }
      if (nodeId.startsWith("src:")) citekeys.add(nodeId.slice(4));

      const extra: IndexNode[] = [];
      for (const ck of citekeys) {
        const more = await queryAll(
          conn,
          `MATCH (n:KnNode) WHERE n.kind = 'fact' AND n.citekey = '${esc(ck)}'
           RETURN n.id AS id, n.kind AS kind, n.name AS name,
             n.status AS status, n.why AS why, n.collection AS collection, n.note AS note,
             n.inTree AS inTree, n.pathRef AS pathRef, n.citekey AS citekey, n.knowledgeId AS knowledgeId,
             n.projectId AS projectId, n.factKey AS factKey, n.value AS value, n.unit AS unit, n.updatedAt AS updatedAt;`,
        );
        for (const r of more) extra.push(rowToNode(r));
        const src = await queryAll(
          conn,
          `MATCH (n:KnNode {id: 'src:${esc(ck)}'})
           RETURN n.id AS id, n.kind AS kind, n.name AS name,
             n.status AS status, n.why AS why, n.collection AS collection, n.note AS note,
             n.inTree AS inTree, n.pathRef AS pathRef, n.citekey AS citekey, n.knowledgeId AS knowledgeId,
             n.projectId AS projectId, n.factKey AS factKey, n.value AS value, n.unit AS unit, n.updatedAt AS updatedAt;`,
        );
        for (const r of src) extra.push(rowToNode(r));
      }

      const byId = new Map<string, IndexNode>();
      for (const r of nodeRows) byId.set(String(r.id), rowToNode(r));
      for (const n of extra) byId.set(n.id, n);
      const ids = [...byId.keys()];
      if (!ids.length) return { nodes: [], edges: [], pathRefs: {} };

      const idList = ids.map((id) => `'${esc(id)}'`).join(", ");
      const edgeRows = await queryAll(
        conn,
        `MATCH (a:KnNode)-[r:BUILT_ON]->(b:KnNode)
         WHERE a.id IN [${idList}] AND b.id IN [${idList}]
         RETURN a.id AS from, b.id AS to, r.flagged AS flagged;`,
      );
      const edges: GraphEdge[] = edgeRows.map((r) => ({
        from: String(r.from),
        to: String(r.to),
        flagged: Boolean(r.flagged),
      }));
      // Ensure source→fact edges for hydrated siblings even if not in BUILT_ON yet
      for (const n of byId.values()) {
        if (n.kind === "fact" && n.citekey) {
          const src = `src:${n.citekey}`;
          if (byId.has(src) && !edges.some((e) => e.from === src && e.to === n.id)) {
            edges.push({ from: src, to: n.id, flagged: n.status === "rejected" });
          }
        }
      }
      const nodes = attachIo([...byId.values()], edges);
      const pathRefs: Record<string, string> = {};
      for (const n of byId.values()) if (n.pathRef) pathRefs[n.id] = n.pathRef;
      return { nodes, edges, pathRefs };
    } catch (err) {
      console.warn("[knowledge-index] neighborhood query failed:", err);
    }
  }

  // Memory BFS fallback
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
  if (conn && readyStamp === memoryFallback.stamp) {
    try {
      const rows = await queryAll(
        conn,
        `MATCH (n:KnNode)
         WHERE toLower(n.name) CONTAINS '${esc(needle)}'
            OR toLower(n.note) CONTAINS '${esc(needle)}'
            OR toLower(n.factKey) CONTAINS '${esc(needle)}'
            OR toLower(n.knowledgeId) CONTAINS '${esc(needle)}'
         RETURN n.id AS id, n.kind AS kind, n.name AS name,
           n.status AS status, n.why AS why, n.collection AS collection, n.note AS note,
           n.inTree AS inTree, n.pathRef AS pathRef, n.citekey AS citekey, n.knowledgeId AS knowledgeId,
           n.projectId AS projectId, n.factKey AS factKey, n.value AS value, n.unit AS unit, n.updatedAt AS updatedAt
         LIMIT ${Math.max(1, Math.min(200, limit))};`,
      );
      return rows.map(rowToNode);
    } catch {
      /* fall through */
    }
  }
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
