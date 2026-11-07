/**
 * Knowledge item projects — create from template, list, resolve ids.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { getProjectsRootAbs } from "../../config.js";
import {
  createProject,
  listProjects,
  readProjectConfig,
  writeProjectConfig,
  type ProjectMeta,
} from "../projectFs.js";
import { projectFolderName } from "../projectFolder.js";

const KNOWLEDGE_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

export function isValidKnowledgeId(id: string): boolean {
  return KNOWLEDGE_ID_RE.test(id);
}

export function slugifyKnowledgeId(title: string): string {
  const s = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  const base = s.replace(/^[^a-z]+/, "") || "knowledge";
  return (base.length < 2 ? `${base}x` : base).slice(0, 64);
}

async function takenKnowledgeIds(): Promise<Set<string>> {
  const taken = new Set<string>();
  const projects = await listProjects();
  for (const p of projects) {
    try {
      const cfg = await readProjectConfig(p.id);
      if (cfg.kind === "knowledge" && cfg.knowledgeId) taken.add(cfg.knowledgeId);
    } catch {
      /* ignore */
    }
  }
  return taken;
}

export async function uniquifyKnowledgeId(preferred: string | undefined, title: string): Promise<string> {
  const taken = await takenKnowledgeIds();
  const seed = preferred && isValidKnowledgeId(preferred) ? preferred : slugifyKnowledgeId(title);
  if (!taken.has(seed)) return seed;
  for (let n = 2; n < 10_000; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${seed.slice(0, 64 - suffix.length)}${suffix}`;
    if (isValidKnowledgeId(candidate) && !taken.has(candidate)) return candidate;
  }
  throw httpError(500, "Could not allocate knowledgeId");
}

const TEMPLATE = `\\documentclass{article}
\\usepackage{openleaf-knowledge}
\\begin{document}
\\begin{knowledge}{TITLE_PLACEHOLDER}

\\conclusion{One or two sentences stating what this item concludes.}

\\end{knowledge}
\\end{document}
`;

export async function createKnowledgeItem(input: {
  title: string;
  collection?: string;
  knowledgeId?: string;
}): Promise<{ project: ProjectMeta; knowledgeId: string }> {
  const title = input.title.trim();
  if (!title) throw httpError(400, "title is required");
  const knowledgeId = await uniquifyKnowledgeId(input.knowledgeId, title);
  const folder = projectFolderName(title).slice(0, 80) || knowledgeId;
  let id = folder;
  const root = getProjectsRootAbs();
  if (fsSync.existsSync(path.join(root, id))) {
    id = `${folder}-${knowledgeId}`.slice(0, 100);
  }
  if (fsSync.existsSync(path.join(root, id))) {
    id = `${knowledgeId}`;
  }
  const project = await createProject(id, "__knowledge_blank__");
  const main = TEMPLATE.replace("TITLE_PLACEHOLDER", title.replace(/[{}]/g, ""));
  await fs.writeFile(path.join(root, project.id, "main.tex"), main, "utf8");
  await writeProjectConfig(project.id, {
    mainFile: "main.tex",
    engine: "pdflatex",
    name: title,
    kind: "knowledge",
    knowledgeId,
    collection: input.collection,
  });
  const { getProject } = await import("../projectFs.js");
  return { project: await getProject(project.id), knowledgeId };
}

export async function listKnowledgeItems(): Promise<
  Array<ProjectMeta & { knowledgeId: string; collection?: string; title: string }>
> {
  const out: Array<ProjectMeta & { knowledgeId: string; collection?: string; title: string }> = [];
  for (const p of await listProjects()) {
    try {
      const cfg = await readProjectConfig(p.id);
      if (cfg.kind !== "knowledge" || !cfg.knowledgeId) continue;
      out.push({
        ...p,
        knowledgeId: cfg.knowledgeId,
        collection: cfg.collection,
        title: cfg.name || p.name,
      });
    } catch {
      /* ignore */
    }
  }
  return out;
}
