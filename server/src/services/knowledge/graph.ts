/**
 * Library-wide knowledge graph + impact + inbox. Spec §6, §7.3–7.4.
 * Status engine lives in status.ts; this module builds nodes/edges.
 *
 * Facts/sources appear only when a knowledge item cites them (product choice —
 * keeps the tree readable as the library grows).
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { getFactsByKeys, listAllFacts } from "../library/facts.js";
import { getPaper } from "../library/index.js";
import { getProjectsRootAbs } from "../../config.js";
import { listKnowledgeItems } from "./items.js";
import { parseKnowledge } from "./parse.js";
import { readProjectConfig } from "../projectFs.js";
import { computeFactStatus, computeItemStatus, computeProjectStatus, type Status } from "./status.js";

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
};

type Cache = { stamp: string; graph: KnowledgeGraph };
let cache: Cache | null = null;

async function mtimeStamp(): Promise<string> {
  const parts: string[] = [];
  const root = getProjectsRootAbs();
  if (fs.existsSync(root)) {
    const names = await fsPromises.readdir(root);
    await Promise.all(
      names.map(async (name) => {
        await Promise.all(
          ["openleaf.json", "review.json", "main.tex"].map(async (file) => {
            try {
              const st = await fsPromises.stat(path.join(root, name, file));
              parts.push(`${name}/${file}:${st.mtimeMs}`);
            } catch {
              /* missing */
            }
          }),
        );
      }),
    );
  }
  // Fact status changes should invalidate the graph even when tex is unchanged.
  try {
    const { getFactKeyIndex } = await import("../library/factKeyIndex.js");
    const idx = await getFactKeyIndex();
    parts.push(`facts:${idx.stamp.length}:${idx.allKeys.size}`);
  } catch {
    /* ignore */
  }
  return parts.sort().join("|");
}

export function invalidateKnowledgeGraph(): void {
  cache = null;
}

type KnParsed = {
  item: Awaited<ReturnType<typeof listKnowledgeItems>>[number];
  refs: ReturnType<typeof parseKnowledge>["refs"];
  steps: ReturnType<typeof parseKnowledge>["steps"];
  errors: ReturnType<typeof parseKnowledge>["errors"];
};

async function loadKnowledgeParsed(): Promise<KnParsed[]> {
  const knItems = await listKnowledgeItems();
  const root = getProjectsRootAbs();
  return Promise.all(
    knItems.map(async (item) => {
      try {
        const main = path.join(root, item.id, "main.tex");
        const text = await fsPromises.readFile(main, "utf8");
        const parsed = parseKnowledge({ "main.tex": text });
        return { item, refs: parsed.refs, steps: parsed.steps, errors: parsed.errors };
      } catch {
        return { item, refs: [], steps: [], errors: [] };
      }
    }),
  );
}

export async function buildKnowledgeGraph(force = false): Promise<KnowledgeGraph> {
  const stamp = await mtimeStamp();
  if (!force && cache && cache.stamp === stamp) return cache.graph;

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const collections = new Set<string>(["unsorted"]);
  const byId = new Map<string, GraphNode>();

  const knParsed = await loadKnowledgeParsed();

  // Only facts that knowledge items actually cite.
  const citedFactKeys = new Set<string>();
  for (const kn of knParsed) {
    for (const r of kn.refs) {
      if (r.kind === "fact" && r.key) citedFactKeys.add(r.key);
    }
  }

  const citedFacts = await getFactsByKeys(citedFactKeys);
  const factByKey = new Map(citedFacts.filter((f) => f.key).map((f) => [f.key!, f]));
  const citekeys = [...new Set(citedFacts.map((f) => f.citekey))];
  const papers = await Promise.all(
    citekeys.map(async (ck) => {
      try {
        return await getPaper(ck);
      } catch {
        return null;
      }
    }),
  );
  const paperByKey = new Map(papers.filter(Boolean).map((p) => [p!.citekey, p!]));

  for (const citekey of citekeys) {
    const paper = paperByKey.get(citekey);
    if (!paper) continue;
    const collection = paper.collections[0] || "unsorted";
    collections.add(collection);
    const node: GraphNode = {
      id: `src:${citekey}`,
      kind: "source",
      name: paper.title,
      status: "up-to-date",
      why: [],
      collection,
      inputs: [],
      outputs: [],
      updatedAt: paper.updatedAt || paper.addedAt,
    };
    nodes.push(node);
    byId.set(node.id, node);
  }

  for (const key of citedFactKeys) {
    const fact = factByKey.get(key);
    const id = `fact:${key}`;
    if (fact) {
      const paper = paperByKey.get(fact.citekey);
      const collection = paper?.collections[0] || "unsorted";
      collections.add(collection);
      const status = computeFactStatus(fact.status);
      const node: GraphNode = {
        id,
        kind: "fact",
        name: key,
        status,
        why: fact.status === "rejected" ? ["rejected by reviewer"] : [],
        collection,
        note: fact.input,
        inputs: [`src:${fact.citekey}`],
        outputs: [],
        updatedAt: fact.updatedAt,
      };
      nodes.push(node);
      byId.set(id, node);
      edges.push({ from: `src:${fact.citekey}`, to: id, flagged: status === "rejected" });
      const src = byId.get(`src:${fact.citekey}`);
      if (src) src.outputs.push(id);
    } else {
      // Cited by knowledge but missing from the library — still show a stub.
      const node: GraphNode = {
        id,
        kind: "fact",
        name: key,
        status: "not_found",
        why: ["fact key not found in library"],
        collection: "unsorted",
        note: "Missing fact",
        inputs: [],
        outputs: [],
        updatedAt: new Date().toISOString(),
      };
      nodes.push(node);
      byId.set(id, node);
    }
  }

  for (const kn of knParsed) {
    const collection = kn.item.collection || "unsorted";
    collections.add(collection);
    const inputSet = new Set<string>();
    for (const r of kn.refs) {
      if (r.kind === "fact" && r.key) inputSet.add(`fact:${r.key}`);
      if ((r.kind === "kn" || r.kind === "knref") && r.id) inputSet.add(`kn:${r.id}`);
    }
    const inputs = [...inputSet];
    const status = computeItemStatus({
      steps: kn.steps.map(() => ({ status: "needs-review" as Status })),
      hasErrors: kn.errors.length > 0,
    });
    const id = `kn:${kn.item.knowledgeId}`;
    const node: GraphNode = {
      id,
      kind: "knowledge",
      name: kn.item.title,
      status,
      why: [],
      collection,
      inputs,
      outputs: [],
      updatedAt: new Date().toISOString(),
    };
    nodes.push(node);
    byId.set(id, node);
    for (const from of inputs) {
      edges.push({ from, to: id, flagged: false });
      const src = byId.get(from);
      if (src) src.outputs.push(id);
    }
  }

  // Ordinary projects that reference facts/kn — only link to nodes already in the graph
  // (facts only exist here if knowledge cites them; kn nodes always exist).
  const root = getProjectsRootAbs();
  if (fs.existsSync(root)) {
    const names = await fsPromises.readdir(root);
    await Promise.all(
      names.map(async (name) => {
        try {
          const cfg = await readProjectConfig(name);
          if (cfg.kind === "knowledge") return;
          const mainPath = path.join(root, name, cfg.mainFile || "main.tex");
          const text = await fsPromises.readFile(mainPath, "utf8");
          if (!/\\fact\{|\\kn\{|\\knref\{/.test(text)) return;
          const parsed = parseKnowledge({ [cfg.mainFile || "main.tex"]: text });
          const inputs: string[] = [];
          for (const r of parsed.refs) {
            if (r.kind === "fact" && r.key) {
              const fid = `fact:${r.key}`;
              if (byId.has(fid)) inputs.push(fid);
            }
            if ((r.kind === "kn" || r.kind === "knref") && r.id) {
              const kid = `kn:${r.id}`;
              if (byId.has(kid)) inputs.push(kid);
            }
          }
          if (!inputs.length) return;
          const collection = cfg.collection || "unsorted";
          collections.add(collection);
          const status = computeProjectStatus(
            inputs.map((id) => byId.get(id)?.status ?? "up-to-date"),
          );
          const id = `proj:${name}`;
          const node: GraphNode = {
            id,
            kind: "project",
            name: cfg.name || name,
            status,
            why: status === "flagged" ? ["depends on flagged or rejected upstream"] : [],
            collection,
            inputs,
            outputs: [],
            updatedAt: new Date().toISOString(),
          };
          nodes.push(node);
          byId.set(id, node);
          for (const from of inputs) {
            edges.push({ from, to: id, flagged: status === "flagged" });
            const src = byId.get(from);
            if (src) src.outputs.push(id);
          }
        } catch {
          /* skip */
        }
      }),
    );
  }

  const graph: KnowledgeGraph = {
    nodes,
    edges,
    collections: [...collections].sort(),
    generatedAt: new Date().toISOString(),
  };
  cache = { stamp, graph };
  return graph;
}

/**
 * Neighborhood around a node for progressive disclosure.
 * When a source (or a fact on a source) is in view, also hydrate *all* facts
 * from that source — not only ones cited by knowledge — so relevant hidden
 * library facts can "come to light" while the default graph stays sparse.
 */
export async function neighborhoodOf(
  nodeId: string,
  depth: number = 2,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
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

  const keep = new Set<string>();
  const queue: Array<{ id: string; d: number }> = [{ id: nodeId, d: 0 }];
  keep.add(nodeId);
  while (queue.length) {
    const { id, d } = queue.shift()!;
    if (d >= maxDepth) continue;
    for (const n of adj.get(id) ?? []) {
      if (keep.has(n)) continue;
      keep.add(n);
      queue.push({ id: n, d: d + 1 });
    }
  }

  // Sources to expand: any src: in the keep set, or the source of a kept fact.
  const expandCitekeys = new Set<string>();
  for (const id of keep) {
    if (id.startsWith("src:")) expandCitekeys.add(id.slice(4));
    if (id.startsWith("fact:")) {
      const existing = graph.nodes.find((n) => n.id === id);
      const src = existing?.inputs.find((i) => i.startsWith("src:"));
      if (src) expandCitekeys.add(src.slice(4));
    }
  }
  if (nodeId.startsWith("src:")) expandCitekeys.add(nodeId.slice(4));

  const extraNodes: GraphNode[] = [];
  const extraEdges: GraphEdge[] = [];
  const have = new Set(graph.nodes.map((n) => n.id));

  for (const citekey of expandCitekeys) {
    let paper;
    try {
      paper = await getPaper(citekey);
    } catch {
      continue;
    }
    const srcId = `src:${citekey}`;
    if (!have.has(srcId)) {
      const collection = paper.collections[0] || "unsorted";
      extraNodes.push({
        id: srcId,
        kind: "source",
        name: paper.title,
        status: "up-to-date",
        why: [],
        collection,
        inputs: [],
        outputs: [],
        updatedAt: paper.updatedAt || paper.addedAt,
      });
      have.add(srcId);
    }
    const { listAllFacts } = await import("../library/facts.js");
    const facts = await listAllFacts({ citekey, skipDisplay: true });
    for (const fact of facts) {
      if (!fact.key) continue;
      const fid = `fact:${fact.key}`;
      if (have.has(fid)) continue;
      const collection = paper.collections[0] || "unsorted";
      const status = computeFactStatus(fact.status);
      extraNodes.push({
        id: fid,
        kind: "fact",
        name: fact.key,
        status,
        why: fact.status === "rejected" ? ["rejected by reviewer"] : [],
        collection,
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
  // skipDisplay: inbox does not need PDF highlight rects
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
      createdBy?: string;
    }> = [];
    const projects = await listProjects();
    const knProjects = await Promise.all(
      projects.map(async (p) => {
        try {
          const cfg = await readProjectConfig(p.id);
          return cfg.kind === "knowledge" ? { p, cfg } : null;
        } catch {
          return null;
        }
      }),
    );
    await Promise.all(
      knProjects.filter(Boolean).map(async (row) => {
        const { p, cfg } = row!;
        try {
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
