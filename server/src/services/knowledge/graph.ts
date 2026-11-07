/**
 * Library-wide knowledge graph + impact + inbox. Spec §6, §7.3–7.4.
 * Status engine lives in status.ts; this module builds nodes/edges.
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { listAllFacts } from "../library/facts.js";
import { listAllRecords } from "../library/index.js";
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
    for (const name of await fsPromises.readdir(root)) {
      for (const file of ["openleaf.json", "review.json", "main.tex"]) {
        try {
          const st = await fsPromises.stat(path.join(root, name, file));
          parts.push(`${name}/${file}:${st.mtimeMs}`);
        } catch {
          /* missing */
        }
      }
    }
  }
  return parts.sort().join("|");
}

export function invalidateKnowledgeGraph(): void {
  cache = null;
}

export async function buildKnowledgeGraph(force = false): Promise<KnowledgeGraph> {
  const stamp = await mtimeStamp();
  if (!force && cache && cache.stamp === stamp) return cache.graph;

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const collections = new Set<string>(["unsorted"]);

  const facts = await listAllFacts();
  const papers = await listAllRecords();
  const paperByKey = new Map(papers.map((p) => [p.citekey, p]));
  const sourcesWithFacts = new Set(facts.map((f) => f.citekey));

  for (const citekey of sourcesWithFacts) {
    const paper = paperByKey.get(citekey);
    if (!paper) continue;
    const collection = paper.collections[0] || "unsorted";
    collections.add(collection);
    nodes.push({
      id: `src:${citekey}`,
      kind: "source",
      name: paper.title,
      status: "up-to-date",
      why: [],
      collection,
      inputs: [],
      outputs: [],
      updatedAt: paper.updatedAt || paper.addedAt,
    });
  }

  for (const fact of facts) {
    if (!fact.key) continue;
    const paper = paperByKey.get(fact.citekey);
    const collection = paper?.collections[0] || "unsorted";
    collections.add(collection);
    const status = computeFactStatus(fact.status);
    const id = `fact:${fact.key}`;
    nodes.push({
      id,
      kind: "fact",
      name: fact.key,
      status,
      why: fact.status === "rejected" ? ["rejected by reviewer"] : [],
      collection,
      note: fact.input,
      inputs: [`src:${fact.citekey}`],
      outputs: [],
      updatedAt: fact.updatedAt,
    });
    edges.push({ from: `src:${fact.citekey}`, to: id, flagged: status === "rejected" });
  }

  const knItems = await listKnowledgeItems();
  for (const item of knItems) {
    const collection = item.collection || "unsorted";
    collections.add(collection);
    let refs: Array<{ kind: string; key?: string; id?: string }> = [];
    try {
      const root = path.join(getProjectsRootAbs(), item.id);
      const main = path.join(root, "main.tex");
      const text = await fsPromises.readFile(main, "utf8");
      const parsed = parseKnowledge({ "main.tex": text });
      refs = parsed.refs;
    } catch {
      /* empty */
    }
    const inputs: string[] = [];
    for (const r of refs) {
      if (r.kind === "fact" && r.key) inputs.push(`fact:${r.key}`);
      if ((r.kind === "kn" || r.kind === "knref") && r.id) inputs.push(`kn:${r.id}`);
    }
    const status = computeItemStatus({
      steps: [],
      hasErrors: false,
    });
    const id = `kn:${item.knowledgeId}`;
    nodes.push({
      id,
      kind: "knowledge",
      name: item.title,
      status,
      why: [],
      collection,
      inputs,
      outputs: [],
      updatedAt: new Date().toISOString(),
    });
    for (const from of inputs) {
      edges.push({ from, to: id, flagged: false });
      const src = nodes.find((n) => n.id === from);
      if (src) src.outputs.push(id);
    }
  }

  // Ordinary projects that reference facts/kn
  for (const name of fs.existsSync(getProjectsRootAbs()) ? await fsPromises.readdir(getProjectsRootAbs()) : []) {
    try {
      const cfg = await readProjectConfig(name);
      if (cfg.kind === "knowledge") continue;
      const mainPath = path.join(getProjectsRootAbs(), name, cfg.mainFile || "main.tex");
      const text = await fsPromises.readFile(mainPath, "utf8");
      if (!/\\fact\{|\\kn\{|\\knref\{/.test(text)) continue;
      const parsed = parseKnowledge({ [cfg.mainFile || "main.tex"]: text });
      const inputs: string[] = [];
      for (const r of parsed.refs) {
        if (r.kind === "fact" && r.key) inputs.push(`fact:${r.key}`);
        if ((r.kind === "kn" || r.kind === "knref") && r.id) inputs.push(`kn:${r.id}`);
      }
      if (!inputs.length) continue;
      const collection = cfg.collection || "unsorted";
      collections.add(collection);
      const status = computeProjectStatus(inputs.map((id) => nodes.find((n) => n.id === id)?.status ?? "up-to-date"));
      const id = `proj:${name}`;
      nodes.push({
        id,
        kind: "project",
        name: cfg.name || name,
        status,
        why: status === "flagged" ? ["depends on flagged or rejected upstream"] : [],
        collection,
        inputs,
        outputs: [],
        updatedAt: new Date().toISOString(),
      });
      for (const from of inputs) edges.push({ from, to: id, flagged: status === "flagged" });
    } catch {
      /* skip */
    }
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
  const facts = await listAllFacts();
  const unreviewed = facts.filter((f) => f.status === "unreviewed");
  const byAgent = new Map<string, typeof unreviewed>();
  const other: typeof unreviewed = [];
  for (const f of unreviewed) {
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
  // Steps whose reviewed text drifted (changed outside OpenLeaf UI)
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
    for (const p of await listProjects()) {
      try {
        const cfg = await readProjectConfig(p.id);
        if (cfg.kind !== "knowledge") continue;
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
    }
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
