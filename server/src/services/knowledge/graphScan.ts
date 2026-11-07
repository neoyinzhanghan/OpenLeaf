/**
 * Scan filesystem → knowledge index payload.
 * Files are authoritative; this is pure derivation.
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { listAllFacts } from "../library/facts.js";
import { humanizeFactLabel } from "../library/factKey.js";
import { getPaper, listAllRecords } from "../library/index.js";
import { getProjectsRootAbs } from "../../config.js";
import { listKnowledgeItems } from "./items.js";
import { parseKnowledge } from "./parse.js";
import { readProjectConfig } from "../projectFs.js";
import {
  computeFactStatus,
  computeItemStatus,
  computeProjectStatus,
  computeStepStatus,
  type Status,
} from "./status.js";
import type { GraphEdge } from "./graph.js";
import type { IndexNode } from "./graphIndex.js";

/** Bump when derived node labels / status rules change so the Kùzu cache rebuilds. */
const LABEL_SCHEMA = "fact-label-v3-truth";

export type ScanPayload = {
  stamp: string;
  nodes: IndexNode[];
  edges: GraphEdge[];
  generatedAt: string;
};

export async function knowledgeContentStamp(): Promise<string> {
  const parts: string[] = [LABEL_SCHEMA];
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
      name: humanizeFactLabel({
        input: fact.input,
        key: fact.key,
        value: fact.value ?? null,
        unit: fact.unit || "",
      }),
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

  const { hashStepBody, readReviewFile } = await import("./review.js");
  const factStatusByKey = new Map(
    allFacts.filter((f) => f.key).map((f) => [f.key!, computeFactStatus(f.status)]),
  );

  /** First pass: resolve steps with fact inputs; kn→kn filled in a second pass. */
  type KnDraft = {
    id: string;
    itemId: string;
    title: string;
    collection: string;
    inputs: string[];
    hasErrors: boolean;
    stepDrafts: Array<{
      id: string;
      textHash: string;
      review: Parameters<typeof computeStepStatus>[0]["review"];
      inputStatuses: Array<{ id: string; status: Status; valueChanged?: boolean }>;
    }>;
  };
  const knDrafts: KnDraft[] = [];

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
    let reviewFile: Awaited<ReturnType<typeof readReviewFile>> = { version: 1, steps: {} };
    try {
      reviewFile = await readReviewFile(item.id);
    } catch {
      /* missing review is fine */
    }
    const stepDrafts =
      parsed?.steps.map((step) => {
        const textHash = hashStepBody(step.body);
        const rec = reviewFile.steps[step.id];
        const inputStatuses = step.refs.map((r) => {
          if (r.kind === "fact" && r.key) {
            const snap = rec?.inputs?.[`fact:${r.key}`];
            const f = allFacts.find((x) => x.key === r.key);
            return {
              id: `fact:${r.key}`,
              status: (factStatusByKey.get(r.key) ?? "unreviewed") as Status,
              valueChanged: snap != null && f != null && snap.value !== f.value,
            };
          }
          if ((r.kind === "kn" || r.kind === "knref") && r.id) {
            return { id: `kn:${r.id}`, status: "needs-review" as Status };
          }
          // \out{…} is an internal result name, not an upstream dependency.
          if (r.kind === "out") {
            return {
              id: `out:${"name" in r ? r.name : "out"}`,
              status: "reviewed" as Status,
            };
          }
          return { id: "unknown", status: "needs-review" as Status };
        });
        return {
          id: step.id,
          textHash,
          review: rec
            ? { hash: rec.hash, verdict: rec.verdict, inputs: rec.inputs }
            : null,
          inputStatuses,
        };
      }) ?? [];
    knDrafts.push({
      id: `kn:${item.knowledgeId}`,
      itemId: item.id,
      title: item.title,
      collection,
      inputs,
      hasErrors: (parsed?.errors.length ?? 0) > 0,
      stepDrafts,
    });
  }

  const finalizeKn = (draft: KnDraft) => {
    const stepResults = draft.stepDrafts.map((s) => computeStepStatus(s));
    const { status, why } = computeItemStatus({
      steps: stepResults,
      hasErrors: draft.hasErrors,
    });
    return { status, why, stepResults };
  };

  // Pass 1
  for (const draft of knDrafts) {
    const { status, why } = finalizeKn(draft);
    push({
      id: draft.id,
      kind: "knowledge",
      name: draft.title,
      status,
      why,
      collection: draft.collection,
      inputs: draft.inputs,
      outputs: [],
      updatedAt: generatedAt,
      inTree: true,
      pathRef: `projects/${draft.itemId}`,
      knowledgeId: draft.id.slice(3),
      projectId: draft.itemId,
    });
    for (const from of draft.inputs) {
      edges.push({
        from,
        to: draft.id,
        flagged: status === "flagged" || status === "rejected" || status === "needs-review",
      });
    }
  }

  // Pass 2: fill kn→kn input statuses from pass-1 results, recompute dependents.
  for (const draft of knDrafts) {
    let changed = false;
    for (const step of draft.stepDrafts) {
      for (const input of step.inputStatuses) {
        if (input.id.startsWith("kn:")) {
          const up = byId.get(input.id);
          if (up && input.status !== up.status) {
            input.status = up.status;
            changed = true;
          }
        }
      }
    }
    if (!changed) continue;
    const { status, why } = finalizeKn(draft);
    const node = byId.get(draft.id);
    if (node) {
      node.status = status;
      node.why = why;
    }
  }

  // Authored papers only (`kind: "paper"`). Notes/benches/etc. are not paper nodes;
  // knowledge items are already added above via kind: "knowledge".
  if (fs.existsSync(root)) {
    const names = await fsPromises.readdir(root);
    await Promise.all(
      names.map(async (name) => {
        try {
          const cfg = await readProjectConfig(name);
          if (cfg.kind !== "paper") return;
          const mainFile = cfg.mainFile || "main.tex";
          const mainPath = path.join(root, name, mainFile);
          let inputs: string[] = [];
          try {
            const text = await fsPromises.readFile(mainPath, "utf8");
            if (/\\fact\{|\\kn\{|\\knref\{/.test(text)) {
              const parsed = parseKnowledge({ [mainFile]: text });
              for (const r of parsed.refs) {
                if (r.kind === "fact" && r.key) inputs.push(`fact:${r.key}`);
                if ((r.kind === "kn" || r.kind === "knref") && r.id) inputs.push(`kn:${r.id}`);
              }
            }
          } catch {
            /* paper may not have a readable main file yet */
          }
          const existing = inputs.filter((id) => byId.has(id));
          const collection = cfg.collection || "papers";
          const projectStatus = existing.length
            ? computeProjectStatus(existing.map((id) => byId.get(id)?.status ?? "needs-review"))
            : ({ status: "up-to-date" as Status, why: [] as string[] });
          const id = `proj:${name}`;
          push({
            id,
            kind: "project",
            name: cfg.name || name.replace(/_/g, " "),
            status: projectStatus.status,
            why: projectStatus.why,
            collection,
            inputs: existing,
            outputs: [],
            updatedAt: generatedAt,
            inTree: true,
            pathRef: `projects/${name}`,
            projectId: name,
          });
          for (const from of existing) {
            edges.push({ from, to: id, flagged: projectStatus.status === "flagged" });
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
