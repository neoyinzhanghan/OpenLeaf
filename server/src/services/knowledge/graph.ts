/**
 * Knowledge graph API. Spec §6, §7.3–7.4.
 *
 * Files are source of truth. Kùzu (library/.cache/knowledge.kuzu) is a derived
 * index for fast tree / neighborhood / search. Falls back to memory if kuzu
 * is unavailable.
 */
import { listAllFacts } from "../library/facts.js";
import { getPaper } from "../library/index.js";
import { computeFactStatus, type Status } from "./status.js";
import { scanKnowledgeUniverse, knowledgeContentStamp } from "./graphScan.js";
import {
  invalidateKnowledgeIndex,
  syncKnowledgeIndex,
  queryTreeGraph,
  queryNeighborhood,
  searchIndex,
  getIndexStatus,
  type IndexNode,
} from "./graphIndex.js";

export type GraphNode = {
  id: string;
  kind: "source" | "fact" | "knowledge" | "project";
  name: string;
  status: Status;
  why: string[];
  collection: string;
  note?: string;
  inputs: string[];
  outputs: string[];
  updatedAt: string;
};

export type GraphEdge = { from: string; to: string; flagged: boolean };

export type KnowledgeGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  collections: string[];
  generatedAt: string;
  /** Present when served from the local graph index. */
  backend?: "kuzu" | "memory";
  pathRefs?: Record<string, string>;
};

export function invalidateKnowledgeGraph(): void {
  invalidateKnowledgeIndex();
}

async function ensureSynced() {
  const stamp = await knowledgeContentStamp();
  return syncKnowledgeIndex(stamp, scanKnowledgeUniverse);
}

export async function buildKnowledgeGraph(force = false): Promise<KnowledgeGraph> {
  if (force) invalidateKnowledgeGraph();
  await ensureSynced();
  const tree = await queryTreeGraph();
  if (!tree) {
    // Should not happen after sync; rebuild once.
    const payload = await scanKnowledgeUniverse();
    await syncKnowledgeIndex(payload.stamp, async () => payload);
    const again = await queryTreeGraph();
    if (!again) throw new Error("Knowledge graph index failed to build");
    return { ...again, backend: getIndexStatus().backend };
  }
  const status = getIndexStatus();
  const pathRefs: Record<string, string> = {};
  // Attach pathRefs for tree nodes from index memory via search of ids — queryTree doesn't return pathRef on GraphNode.
  // Clients that need paths can call neighborhood / search. Optional: stash on note. Skip for tree payload size.
  return { ...tree, backend: status.backend, pathRefs };
}

export async function neighborhoodOf(
  nodeId: string,
  depth: number = 2,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; pathRefs: Record<string, string> }> {
  await ensureSynced();
  const fromIndex = await queryNeighborhood(nodeId, depth);
  if (fromIndex) return fromIndex;

  // Last-resort: expand sources from files (same behaviour as before index).
  const graph = await buildKnowledgeGraph();
  const maxDepth = Math.max(0, Math.min(8, Math.floor(depth)));
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    const a = adj.get(e.from) ?? [];
    a.push(e.to);
    adj.set(e.from, a);
    const b = adj.get(e.to) ?? [];
    b.push(e.from);
    adj.set(e.to, b);
  }
  const keep = new Set<string>([nodeId]);
  const queue: Array<{ id: string; d: number }> = [{ id: nodeId, d: 0 }];
  while (queue.length) {
    const { id, d } = queue.shift()!;
    if (d >= maxDepth) continue;
    for (const n of adj.get(id) ?? []) {
      if (keep.has(n)) continue;
      keep.add(n);
      queue.push({ id: n, d: d + 1 });
    }
  }
  const expandCitekeys = new Set<string>();
  for (const id of keep) {
    if (id.startsWith("src:")) expandCitekeys.add(id.slice(4));
  }
  if (nodeId.startsWith("src:")) expandCitekeys.add(nodeId.slice(4));

  const extraNodes: GraphNode[] = [];
  const extraEdges: GraphEdge[] = [];
  const have = new Set(graph.nodes.map((n) => n.id));
  const pathRefs: Record<string, string> = {};

  for (const citekey of expandCitekeys) {
    let paper;
    try {
      paper = await getPaper(citekey);
    } catch {
      continue;
    }
    const srcId = `src:${citekey}`;
    pathRefs[srcId] = `library/papers/${citekey}`;
    if (!have.has(srcId)) {
      extraNodes.push({
        id: srcId,
        kind: "source",
        name: paper.title,
        status: "up-to-date",
        why: [],
        collection: paper.collections[0] || "unsorted",
        inputs: [],
        outputs: [],
        updatedAt: paper.updatedAt || paper.addedAt,
      });
      have.add(srcId);
    }
    const facts = await listAllFacts({ citekey, skipDisplay: true });
    for (const fact of facts) {
      if (!fact.key) continue;
      const fid = `fact:${fact.key}`;
      pathRefs[fid] = `library/papers/${citekey}/facts.json#${fact.id}`;
      if (have.has(fid)) continue;
      const status = computeFactStatus(fact.status);
      extraNodes.push({
        id: fid,
        kind: "fact",
        name: fact.key,
        status,
        why: fact.status === "rejected" ? ["rejected by reviewer"] : [],
        collection: paper.collections[0] || "unsorted",
        note: fact.input,
        inputs: [srcId],
        outputs: [],
        updatedAt: fact.updatedAt,
      });
      extraEdges.push({ from: srcId, to: fid, flagged: status === "rejected" });
      have.add(fid);
      keep.add(fid);
    }
    keep.add(srcId);
  }

  const baseNodes = graph.nodes.filter((n) => keep.has(n.id));
  const baseEdges = graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  return {
    nodes: [...baseNodes, ...extraNodes],
    edges: [...baseEdges, ...extraEdges],
    pathRefs,
  };
}

export async function impactOf(nodeId: string): Promise<{
  node: string;
  flagged: GraphNode[];
  notAffectedCount: number;
}> {
  const graph = await buildKnowledgeGraph();
  const downstream = new Set<string>();
  const walk = (id: string) => {
    for (const e of graph.edges) {
      if (e.from === id && !downstream.has(e.to)) {
        downstream.add(e.to);
        walk(e.to);
      }
    }
  };
  walk(nodeId);
  const flagged = graph.nodes.filter(
    (n) => downstream.has(n.id) && (n.status === "flagged" || n.status === "rejected" || n.status === "needs-review"),
  );
  return {
    node: nodeId,
    flagged,
    notAffectedCount: Math.max(0, downstream.size - flagged.length),
  };
}

export async function knowledgeInbox(): Promise<{
  groups: Array<{
    title: string;
    kind: "agent" | "changed" | "flagged";
    items: Array<{
      type: "fact" | "step" | "knowledge" | "project";
      id: string;
      label: string;
      status: Status;
      citekey?: string;
      factId?: string;
      createdBy?: string;
    }>;
  }>;
}> {
  const facts = await listAllFacts({ status: "unreviewed", skipDisplay: true });
  const byAgent = new Map<string, typeof facts>();
  const other: typeof facts = [];
  for (const f of facts) {
    if (f.createdBy?.kind === "agent" && f.createdBy.name) {
      const list = byAgent.get(f.createdBy.name) ?? [];
      list.push(f);
      byAgent.set(f.createdBy.name, list);
    } else other.push(f);
  }
  const groups: Awaited<ReturnType<typeof knowledgeInbox>>["groups"] = [];
  for (const [name, list] of byAgent) {
    groups.push({
      title: `Agent: ${name}`,
      kind: "agent",
      items: list.map((f) => ({
        type: "fact" as const,
        id: f.key || f.id,
        label: f.input,
        status: "needs-review" as const,
        citekey: f.citekey,
        factId: f.id,
        createdBy: name,
      })),
    });
  }
  if (other.length) {
    groups.push({
      title: "Unreviewed facts",
      kind: "changed",
      items: other.map((f) => ({
        type: "fact" as const,
        id: f.key || f.id,
        label: f.input,
        status: "needs-review" as const,
        citekey: f.citekey,
        factId: f.id,
      })),
    });
  }
  try {
    const { listProjects, readProjectConfig } = await import("../projectFs.js");
    const { listStepStatuses } = await import("./review.js");
    const changedSteps: Array<{
      type: "step";
      id: string;
      label: string;
      status: Status;
    }> = [];
    const projects = await listProjects();
    await Promise.all(
      projects.map(async (p) => {
        try {
          const cfg = await readProjectConfig(p.id);
          if (cfg.kind !== "knowledge") return;
          for (const s of await listStepStatuses(p.id)) {
            if (s.status === "needs-review" && s.reviewedText && s.reviewedText !== s.body) {
              changedSteps.push({
                type: "step",
                id: `${p.id}:${s.id}`,
                label: `${cfg.name || p.name} · ${s.id}`,
                status: "needs-review",
              });
            }
          }
        } catch {
          /* ignore */
        }
      }),
    );
    if (changedSteps.length) {
      groups.push({ title: "Changed outside OpenLeaf", kind: "changed", items: changedSteps });
    }
  } catch {
    /* ignore */
  }

  const graph = await buildKnowledgeGraph();
  const flagged = graph.nodes.filter((n) => n.status === "flagged" || n.status === "rejected");
  if (flagged.length) {
    groups.push({
      title: "Flagged",
      kind: "flagged",
      items: flagged.map((n) => ({
        type: n.kind === "knowledge" ? "knowledge" : n.kind === "project" ? "project" : "fact",
        id: n.id,
        label: n.name,
        status: n.status,
      })),
    });
  }
  return { groups };
}

export async function knowledgeSearch(q: string, limit = 40): Promise<IndexNode[]> {
  await ensureSynced();
  return searchIndex(q, limit);
}

export function knowledgeIndexStatus() {
  return getIndexStatus();
}
