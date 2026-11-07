/**
 * Before compile: parse project, evaluate, write openleaf-values.tex into a
 * per-project generated dir outside the project tree; return TEXINPUTS pieces.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRepoRoot } from "../../config.js";
import { listAllFacts } from "../library/facts.js";
import { parseKnowledge } from "./parse.js";
import { evaluateKnowledgeGraph, formatKnowledgeNumber } from "./evaluate.js";
import { renderValuesFile, type ValuesFileBuiltOn } from "./valuesFile.js";
import { listKnowledgeItems } from "./items.js";
import { readProjectConfig, resolveProjectPath } from "../projectFs.js";

const STY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tex");

export function knowledgeStyDir(): string {
  return STY_DIR;
}

export function knowledgeGenRoot(): string {
  return path.join(getRepoRoot(), "config", "runtime", "knowledge-values");
}

async function readProjectTexFiles(projectId: string): Promise<Record<string, string>> {
  const root = resolveProjectPath(projectId, ".");
  const files: Record<string, string> = {};
  const walk = async (dir: string, rel: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name === ".git" || ent.name === ".openleaf" || ent.name === "node_modules") continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(abs, r);
      else if (ent.isFile() && ent.name.toLowerCase().endsWith(".tex")) {
        files[r.replace(/\\/g, "/")] = await fs.readFile(abs, "utf8");
      }
    }
  };
  await walk(root, "");
  return files;
}

export type PrepareKnowledgeCompileResult = {
  texinputs: string;
  genDir: string;
  errors: Array<{ message: string; line?: number; file?: string }>;
  usesKnowledge: boolean;
};

export async function prepareKnowledgeCompile(projectId: string): Promise<PrepareKnowledgeCompileResult> {
  const files = await readProjectTexFiles(projectId);
  const cfg = await readProjectConfig(projectId);
  const mainFile = cfg.mainFile || "main.tex";
  const joined = Object.values(files).join("\n");
  const usesKnowledge = /\\usepackage\{openleaf-knowledge\}/.test(joined) || /\\fact\{/.test(joined) || /\\kn\{/.test(joined);
  if (!usesKnowledge) {
    return { texinputs: "", genDir: "", errors: [], usesKnowledge: false };
  }

  const parsed = parseKnowledge(files, mainFile);
  const errors: Array<{ message: string; line?: number; file?: string }> = [...parsed.errors];

  const allFacts = await listAllFacts();
  const factMap = new Map(
    allFacts.filter((f) => f.key).map((f) => [f.key!, { value: f.value ?? null, rejected: f.status === "rejected" }]),
  );

  const knItems = await listKnowledgeItems();
  const graphItems = [];
  for (const item of knItems) {
    try {
      const itemFiles = await readProjectTexFiles(item.id);
      const itemCfg = await readProjectConfig(item.id);
      const p = parseKnowledge(itemFiles, itemCfg.mainFile || "main.tex");
      const dependsOn = [
        ...new Set(
          p.refs.filter((r) => r.kind === "kn" || r.kind === "knref").map((r) => ("id" in r ? r.id : "")).filter(Boolean),
        ),
      ];
      graphItems.push({
        knowledgeId: item.knowledgeId,
        resultName: p.resultName,
        dependsOn,
        steps: p.steps.map((s) => ({
          id: s.id,
          kind: s.kind,
          name: s.name,
          body: s.body,
          sets: s.sets,
        })),
      });
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
    }
  }

  const evaluated = evaluateKnowledgeGraph(graphItems, factMap);
  for (const v of evaluated.values()) errors.push(...v.errors);

  const localOuts: Record<string, number> = {};
  const thisKn = cfg.knowledgeId ? evaluated.get(cfg.knowledgeId) : undefined;
  if (thisKn) Object.assign(localOuts, thisKn.outputs);
  for (const step of parsed.steps) {
    for (const set of step.sets) localOuts[set.name] = set.value;
    if (step.kind === "calculation" && step.name && thisKn?.outputs[step.name] != null) {
      localOuts[step.name] = thisKn.outputs[step.name]!;
    }
  }

  // Also evaluate this project's calcs directly if not in the kn list yet
  if (cfg.kind === "knowledge" && cfg.knowledgeId && !evaluated.has(cfg.knowledgeId)) {
    const one = evaluateKnowledgeGraph(
      [
        {
          knowledgeId: cfg.knowledgeId,
          resultName: parsed.resultName,
          dependsOn: [],
          steps: parsed.steps.map((s) => ({
            id: s.id,
            kind: s.kind,
            name: s.name,
            body: s.body,
            sets: s.sets,
          })),
        },
      ],
      factMap,
    );
    const v = one.get(cfg.knowledgeId);
    if (v) {
      Object.assign(localOuts, v.outputs);
      errors.push(...v.errors);
      evaluated.set(cfg.knowledgeId, v);
    }
  }

  const factByKey = new Map(allFacts.filter((f) => f.key).map((f) => [f.key!, f]));
  const knById = new Map(knItems.map((k) => [k.knowledgeId, k]));
  const builtOnKeys = new Set<string>();
  const builtOn: ValuesFileBuiltOn[] = [];
  for (const r of parsed.refs) {
    if (r.kind === "fact" && r.key && !builtOnKeys.has(`fact:${r.key}`)) {
      builtOnKeys.add(`fact:${r.key}`);
      const f = factByKey.get(r.key);
      if (!f) continue;
      const page =
        f.highlights?.[0]?.page != null
          ? f.sourceKind === "web"
            ? "saved text"
            : `p. ${f.highlights[0].page}`
          : "";
      const saved = f.updatedAt ? `saved ${f.updatedAt.slice(0, 10)}` : "";
      builtOn.push({
        kind: "fact",
        label: f.input || r.key,
        value:
          f.answer?.trim() ||
          (f.value != null ? formatKnowledgeNumber(f.value, { unit: f.unit ?? "" }) : "—"),
        sourceLine: [f.citekey, page, saved].filter(Boolean).join(" · "),
      });
    }
    if ((r.kind === "kn" || r.kind === "knref") && r.id && !builtOnKeys.has(`kn:${r.id}`)) {
      builtOnKeys.add(`kn:${r.id}`);
      const k = knById.get(r.id);
      const v = evaluated.get(r.id);
      builtOn.push({
        kind: "knowledge",
        label: k?.title || r.id,
        value: v?.primary != null ? formatKnowledgeNumber(v.primary) : "—",
        sourceLine: `knowledge item · ${r.id}`,
      });
    }
  }

  const values = renderValuesFile({
    facts: allFacts
      .filter((f) => f.key)
      .map((f) => ({
        key: f.key!,
        answer: f.answer,
        value: f.value ?? null,
        unit: f.unit ?? "",
      })),
    knowledge: knItems.map((k) => {
      const v = evaluated.get(k.knowledgeId);
      return {
        knowledgeId: k.knowledgeId,
        title: k.title,
        primary: v?.primary ?? null,
        outputs: v?.outputs ?? {},
      };
    }),
    localOuts,
    builtOn,
  });

  const genDir = path.join(knowledgeGenRoot(), projectId);
  await fs.mkdir(genDir, { recursive: true });
  await fs.writeFile(path.join(genDir, "openleaf-values.tex"), values, "utf8");

  // Ensure sty is findable
  if (!fsSync.existsSync(path.join(STY_DIR, "openleaf-knowledge.sty"))) {
    errors.push({ message: "openleaf-knowledge.sty missing from server/tex" });
  }

  const texinputs = `${STY_DIR}${path.delimiter}${genDir}${path.delimiter}`;
  return { texinputs, genDir, errors, usesKnowledge: true };
}
