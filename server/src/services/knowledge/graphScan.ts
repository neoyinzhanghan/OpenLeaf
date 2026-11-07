/**
 * Scan filesystem → knowledge index payload.
 * Files are authoritative; this is pure derivation.
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { listAllFacts } from "../library/facts.js";
import { getPaper, listAllRecords } from "../library/index.js";
import { getProjectsRootAbs } from "../../config.js";
import { listKnowledgeItems } from "./items.js";
import { parseKnowledge } from "./parse.js";
import { readProjectConfig } from "../projectFs.js";
import { computeFactStatus, computeItemStatus, computeProjectStatus, type Status } from "./status.js";
import type { GraphEdge } from "./graph.js";
import type { IndexNode } from "./graphIndex.js";

export type ScanPayload = {
  stamp: string;
  nodes: IndexNode[];
  edges: GraphEdge[];
  generatedAt: string;
};

export async function knowledgeContentStamp(): Promise<string> {
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
  try {
    const { getFactKeyIndex } = await import("../library/factKeyIndex.js");
    const idx = await getFactKeyIndex();
    parts.push(`facts:${idx.stamp}`);
  } catch {
    /* ignore */
  }
  return parts.sort().join("|");
}

export async function scanKnowledgeUniverse(): Promise<ScanPayload> {
  const stamp = await knowledgeContentStamp();
  const generatedAt = new Date().toISOString();
  const nodes: IndexNode[] = [];
  const edges: GraphEdge[] = [];
  const byId = new Map<string, IndexNode>();

  const push = (n: IndexNode) => {
    byId.set(n.id, n);
  };

  // All facts (lightweight) — indexed for search/neighborhood; only cited ones inTree.
  const allFacts = await listAllFacts({ skipDisplay: true });
  const papers = await listAllRecords();
  const paperByKey = new Map(papers.map((p) => [p.citekey, p]));
  const citedFactKeys = new Set<string>();

  const knItems = await listKnowledgeItems();
  const root = getProjectsRootAbs();
  const knParsed = await Promise.all(
    knItems.map(async (item) => {
      try {
        const text = await fsPromises.readFile(path.join(root, item.id, "main.tex"), "utf8");
        const parsed = parseKnowledge({ "main.tex": text });
        return { item, parsed };
      } catch {
        return { item, parsed: null };
      }
    }),
  );

  for (const { parsed } of knParsed) {
    if (!parsed) continue;
    for (const r of parsed.refs) {
      if (r.kind === "fact" && r.key) citedFactKeys.add(r.key);
    }
  }

  const sourcesNeeded = new Set<string>();
  for (const fact of allFacts) {
    if (!fact.key) continue;
    sourcesNeeded.add(fact.citekey);
  }

  for (const citekey of sourcesNeeded) {
    const paper = paperByKey.get(citekey);
    if (!paper) continue;
    const collection = paper.collections[0] || "unsorted";
    const hasCitedFact = allFacts.some((f) => f.citekey === citekey && f.key && citedFactKeys.has(f.key));
    push({
      id: `src:${citekey}`,
      kind: "source",
      name: paper.title,
      status: "up-to-date",
      why: [],
      collection,
      inputs: [],
      outputs: [],
      updatedAt: paper.updatedAt || paper.addedAt,
      inTree: hasCitedFact,
      pathRef: `library/papers/${citekey}`,
      citekey,
    });
  }

  for (const fact of allFacts) {
    if (!fact.key) continue;
    const paper = paperByKey.get(fact.citekey);
    const collection = paper?.collections[0] || "unsorted";
    const status = computeFactStatus(fact.status);
    const inTree = citedFactKeys.has(fact.key);
    const id = `fact:${fact.key}`;
    push({
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
      inTree,
      pathRef: `library/papers/${fact.citekey}/facts.json#${fact.id}`,
      citekey: fact.citekey,
      factKey: fact.key,
      value: fact.value ?? null,
      unit: fact.unit || "",
    });
    edges.push({ from: `src:${fact.citekey}`, to: id, flagged: status === "rejected" });
  }

  for (const { item, parsed } of knParsed) {
    const collection = item.collection || "unsorted";
    const inputSet = new Set<string>();
    if (parsed) {
      for (const r of parsed.refs) {
        if (r.kind === "fact" && r.key) inputSet.add(`fact:${r.key}`);
        if ((r.kind === "kn" || r.kind === "knref") && r.id) inputSet.add(`kn:${r.id}`);
      }
    }
    const inputs = [...inputSet];
    const status = computeItemStatus({
      steps: (parsed?.steps ?? []).map(() => ({ status: "needs-review" as Status })),
      hasErrors: (parsed?.errors.length ?? 0) > 0,
    });
    const id = `kn:${item.knowledgeId}`;
    push({
      id,
      kind: "knowledge",
      name: item.title,
      status,
      why: [],
      collection,
      inputs,
      outputs: [],
      updatedAt: generatedAt,
      inTree: true,
      pathRef: `projects/${item.id}`,
      knowledgeId: item.knowledgeId,
      projectId: item.id,
    });
    for (const from of inputs) {
      edges.push({ from, to: id, flagged: false });
    }
  }

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
            if (r.kind === "fact" && r.key) inputs.push(`fact:${r.key}`);
            if ((r.kind === "kn" || r.kind === "knref") && r.id) inputs.push(`kn:${r.id}`);
          }
          if (!inputs.length) return;
          // Only keep edges to nodes that exist
          const existing = inputs.filter((id) => byId.has(id));
          if (!existing.length) return;
          const collection = cfg.collection || "unsorted";
          const status = computeProjectStatus(
            existing.map((id) => byId.get(id)?.status ?? "up-to-date"),
          );
          const id = `proj:${name}`;
          push({
            id,
            kind: "project",
            name: cfg.name || name,
            status,
            why: status === "flagged" ? ["depends on flagged or rejected upstream"] : [],
            collection,
            inputs: existing,
            outputs: [],
            updatedAt: generatedAt,
            inTree: true,
            pathRef: `projects/${name}`,
            projectId: name,
          });
          for (const from of existing) {
            edges.push({ from, to: id, flagged: status === "flagged" });
          }
        } catch {
          /* skip */
        }
      }),
    );
  }

  // Drop edges whose endpoints were never created (missing facts etc.)
  const ids = new Set(byId.keys());
  const cleanEdges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  // Dedupe edges
  const edgeKey = (e: GraphEdge) => `${e.from}->${e.to}`;
  const edgeMap = new Map(cleanEdges.map((e) => [edgeKey(e), e]));

  return {
    stamp,
    nodes: [...byId.values()],
    edges: [...edgeMap.values()],
    generatedAt,
  };
}

/** Resolve a paper quickly for neighborhood hydrate when index misses. */
export async function safeGetPaper(citekey: string) {
  try {
    return await getPaper(citekey);
  } catch {
    return null;
  }
}
