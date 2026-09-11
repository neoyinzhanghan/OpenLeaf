import fs from "node:fs";
import path from "node:path";
import type { Attribution } from "./schema.js";

const SAFE_ID = /^[a-zA-Z0-9._-]+$/;

export function safeFsId(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (s || "unknown").slice(0, 120);
}

export function attributeAbsPath(absPath: string, projectsRoot: string): Attribution | null {
  const root = path.resolve(projectsRoot);
  const full = path.resolve(absPath);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(prefix)) return null;
  const rel = path.relative(root, full).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) return null;
  const parts = rel.split("/").filter(Boolean);
  const projectId = parts[0];
  if (!projectId || projectId.startsWith(".") || !SAFE_ID.test(projectId)) return null;
  if (!fs.existsSync(path.join(root, projectId)) || !fs.statSync(path.join(root, projectId)).isDirectory()) {
    return null;
  }
  if (parts[1] === ".openleaf" && parts[2] === "worktrees" && parts[3] && SAFE_ID.test(parts[3])) {
    return { projectId, branchId: parts[3] };
  }
  return { projectId, branchId: "main" };
}

function looksLikePath(s: string): boolean {
  if (s.length < 2 || s.length > 4096) return false;
  if (s.includes("\n") || s.includes("\0") || s.includes("://")) return false;
  if (s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s)) return true;
  if (s.includes("/") || s.includes("\\")) return true;
  return false;
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || value == null) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out, depth + 1);
    }
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return value;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return value;
  }
}

/** Pull path-bearing strings from a Cursor hook payload and map them onto papers. */
export function attributionsFromPayload(
  payload: Record<string, unknown>,
  projectsRoot: string,
): Attribution[] {
  const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
  const strings: string[] = [];
  const directKeys = ["file_path", "cwd", "working_directory", "target_directory"] as const;
  for (const key of directKeys) {
    if (typeof payload[key] === "string") strings.push(payload[key] as string);
  }
  if (Array.isArray(payload.attachments)) collectStrings(payload.attachments, strings);
  if (Array.isArray(payload.modified_files)) collectStrings(payload.modified_files, strings);
  collectStrings(parseMaybeJson(payload.tool_input), strings);

  const found = new Map<string, Attribution>();
  for (const raw of strings) {
    if (!looksLikePath(raw)) continue;
    const candidates = [raw];
    if (cwd && !path.isAbsolute(raw)) candidates.push(path.resolve(cwd, raw));
    if (!path.isAbsolute(raw)) candidates.push(path.resolve(projectsRoot, raw));
    for (const candidate of candidates) {
      const hit = attributeAbsPath(candidate, projectsRoot);
      if (hit) found.set(`${hit.projectId}::${hit.branchId}`, hit);
    }
  }
  return [...found.values()];
}

export function unionAttributions(a: Attribution[], b: Attribution[]): Attribution[] {
  const found = new Map<string, Attribution>();
  for (const hit of [...a, ...b]) found.set(`${hit.projectId}::${hit.branchId}`, hit);
  return [...found.values()];
}

export function branchRootFor(projectsRoot: string, hit: Attribution): string {
  const project = path.join(path.resolve(projectsRoot), hit.projectId);
  if (hit.branchId === "main") return project;
  return path.join(project, ".openleaf", "worktrees", hit.branchId);
}
