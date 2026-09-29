import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import * as Y from "yjs";
import {
  isProtectedNormalizedPath,
  normalizeAccessPath,
  PROTECTED_FILE_PATTERNS,
  PROTECTED_FILE_REASON,
  projectDir,
  type StoredFileAccessRule,
  type TreeNode,
} from "./projectFs.js";

export {
  normalizeAccessPath,
  PROTECTED_FILE_PATTERNS,
  PROTECTED_FILE_REASON,
};

export type FileAccessActor = "local" | "device" | "guest" | "ai";
export type FileAccessLevel = "everyone" | "host" | "local";
export type FileAccessReason = "protected" | "locked-host" | "locked-local" | null;

export type FileAccessRule = StoredFileAccessRule;

export type FileAccessDecision = {
  canWrite: boolean;
  reason: FileAccessReason;
  rule?: FileAccessRule;
  /** Effective rule level. `everyone` when nothing restricts the path. */
  level: FileAccessLevel;
  protected: boolean;
};

export type FileAccessView = {
  protected: { pattern: string; reason: string }[];
  rules: FileAccessRule[];
};

type AccessRequest = {
  access?: { mode: "host"; remote?: boolean } | { mode: "guest" };
  ai?: boolean;
};

const RANK: Record<FileAccessLevel, number> = { everyone: 0, host: 1, local: 2 };

function deny(rel: string, reason: Exclude<FileAccessReason, null>): never {
  const code = reason === "protected" ? "FILE_PROTECTED" : "FILE_LOCKED";
  const message =
    reason === "protected"
      ? PROTECTED_FILE_REASON
      : reason === "locked-host"
        ? "The host locked this file."
        : "This file can only be edited on the computer running OpenLeaf.";
  throw Object.assign(new Error(message), { status: 403, code, path: rel, reason });
}

export function resolveActor(req: AccessRequest): FileAccessActor {
  if (req.ai) return "ai";
  if (req.access?.mode === "guest") return "guest";
  if (req.access?.mode === "host" && req.access.remote) return "device";
  return "local";
}

function configPath(projectId: string): string {
  return path.join(projectDir(projectId), "openleaf.json");
}

function validRule(raw: unknown): FileAccessRule | null {
  if (!raw || typeof raw !== "object") return null;
  const rule = raw as Partial<FileAccessRule>;
  if (typeof rule.path !== "string" || (rule.level !== "host" && rule.level !== "local")) return null;
  if (typeof rule.setBy !== "string" || typeof rule.setAt !== "string") return null;
  return { path: rule.path, level: rule.level, setBy: rule.setBy, setAt: rule.setAt };
}

async function readRules(projectId: string): Promise<FileAccessRule[]> {
  try {
    const raw = JSON.parse(await fs.readFile(configPath(projectId), "utf8")) as {
      fileAccess?: { rules?: unknown };
    };
    const rules = raw.fileAccess?.rules;
    if (!Array.isArray(rules)) return [];
    return rules.map(validRule).filter((rule): rule is FileAccessRule => rule !== null);
  } catch {
    return [];
  }
}

async function writeRules(projectId: string, rules: FileAccessRule[]): Promise<void> {
  const dest = configPath(projectId);
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(dest, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    raw = {};
  }
  raw.fileAccess = { rules };
  await fs.writeFile(dest, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

export async function listFileAccess(projectId: string): Promise<FileAccessView> {
  return { protected: PROTECTED_FILE_PATTERNS, rules: await readRules(projectId) };
}

function specificity(rulePath: string, target: string): number | null {
  const rule = rulePath.toLowerCase();
  const pathLower = target.toLowerCase();
  if (rule === pathLower) return 1_000_000 + rule.length;
  if (pathLower.startsWith(`${rule}/`)) return rule.length;
  return null;
}

function bestRule(rules: FileAccessRule[], target: string): FileAccessRule | undefined {
  let best: FileAccessRule | undefined;
  let score = -1;
  for (const rule of rules) {
    const next = specificity(rule.path, target);
    if (next != null && next > score) {
      score = next;
      best = rule;
    }
  }
  return best;
}

function levelRestricts(level: FileAccessLevel, actor: FileAccessActor): boolean {
  if (level === "everyone") return false;
  if (level === "host") return actor === "guest" || actor === "ai";
  return actor !== "local";
}

/** Follow the real path. Missing files resolve through the nearest existing ancestor. */
async function realRelative(projectId: string, normalized: string): Promise<string | "escape" | null> {
  const root = projectDir(projectId);
  let rootReal = root;
  try {
    rootReal = await fs.realpath(root);
  } catch {
    return null;
  }
  const full = path.resolve(root, normalized);
  let cursor = full;
  const suffix: string[] = [];
  while (cursor !== root && cursor !== path.dirname(cursor)) {
    try {
      await fs.lstat(cursor);
      break;
    } catch {
      suffix.unshift(path.basename(cursor));
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  if (!cursor.startsWith(root)) return null;
  let real: string;
  try {
    real = await fs.realpath(cursor);
  } catch {
    return null;
  }
  const joined = suffix.length ? path.join(real, ...suffix) : real;
  const rel = path.relative(rootReal, joined);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return "escape";
  return normalizeAccessPath(rel.split(path.sep).join("/"));
}

function decisionFor(
  actor: FileAccessActor,
  targets: string[],
  rules: FileAccessRule[],
  escaped: boolean,
): FileAccessDecision {
  if (escaped && actor !== "local") {
    return { canWrite: false, reason: "protected", level: "local", protected: true };
  }
  const protectedHit = targets.some((target) => isProtectedNormalizedPath(target));
  if (protectedHit && actor !== "local") {
    return { canWrite: false, reason: "protected", level: "local", protected: true };
  }
  let strictest: FileAccessRule | undefined;
  let rank = 0;
  for (const target of targets) {
    const rule = bestRule(rules, target);
    const next = rule ? RANK[rule.level] : 0;
    if (next > rank) {
      rank = next;
      strictest = rule;
    }
  }
  const level: FileAccessLevel = strictest?.level ?? "everyone";
  if (level === "local" && actor !== "local") {
    return { canWrite: false, reason: "locked-local", rule: strictest, level, protected: protectedHit };
  }
  if (level === "host" && (actor === "guest" || actor === "ai")) {
    return { canWrite: false, reason: "locked-host", rule: strictest, level, protected: protectedHit };
  }
  return { canWrite: true, reason: null, rule: strictest, level, protected: protectedHit };
}

async function targetsFor(projectId: string, normalized: string): Promise<{ targets: string[]; escaped: boolean }> {
  const targets = [normalized];
  const real = await realRelative(projectId, normalized);
  if (real === "escape") return { targets, escaped: true };
  if (real && real.toLowerCase() !== normalized.toLowerCase()) targets.push(real);
  return { targets, escaped: false };
}

export async function effectiveAccess(
  projectId: string,
  relativePath: string,
  actor: FileAccessActor,
): Promise<FileAccessDecision> {
  const normalized = normalizeAccessPath(relativePath);
  const rules = await readRules(projectId);
  const { targets, escaped } = await targetsFor(projectId, normalized);
  return decisionFor(actor, targets, rules, escaped);
}

async function descendantRels(projectId: string, normalized: string): Promise<string[]> {
  const full = path.join(projectDir(projectId), normalized);
  let st: fsSync.Stats;
  try {
    st = await fs.lstat(full);
  } catch {
    return [];
  }
  if (!st.isDirectory() || st.isSymbolicLink()) return [];
  const out: string[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      out.push(childRel);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(path.join(abs, entry.name), childRel);
      }
    }
  }
  await walk(full, normalized);
  return out;
}

export async function assertCanWrite(
  projectId: string,
  relativePath: string,
  actor: FileAccessActor,
): Promise<void> {
  const normalized = normalizeAccessPath(relativePath);
  if (!normalized) {
    throw Object.assign(new Error("Invalid path"), { status: 400 });
  }
  const own = await effectiveAccess(projectId, normalized, actor);
  if (!own.canWrite && own.reason) deny(normalized, own.reason);
  for (const child of await descendantRels(projectId, normalized)) {
    const access = await effectiveAccess(projectId, child, actor);
    if (!access.canWrite && access.reason) deny(child, access.reason);
  }
}

function actorMayChangeRules(actor: FileAccessActor): boolean {
  return actor === "local" || actor === "device";
}

function assertMayLoosen(
  actor: FileAccessActor,
  rules: FileAccessRule[],
  target: string,
  nextLevel: FileAccessLevel,
): void {
  if (actor === "local") return;
  if (!actorMayChangeRules(actor)) {
    throw Object.assign(new Error("Only the host can change file access"), { status: 403, code: "FILE_LOCKED", path: target, reason: "locked-host" });
  }
  const exact = rules.find((rule) => rule.path.toLowerCase() === target.toLowerCase());
  const inherited = bestRule(
    rules.filter((rule) => rule.path.toLowerCase() !== target.toLowerCase()),
    target,
  );
  if (exact && RANK[nextLevel] < RANK[exact.level] && levelRestricts(exact.level, actor)) {
    deny(target, exact.level === "local" ? "locked-local" : "locked-host");
  }
  if (inherited && RANK[nextLevel] < RANK[inherited.level] && levelRestricts(inherited.level, actor)) {
    deny(target, inherited.level === "local" ? "locked-local" : "locked-host");
  }
}

export async function putFileAccessRules(
  projectId: string,
  actor: FileAccessActor,
  body: { upsert?: { path: string; level: FileAccessLevel }[]; delete?: string[] },
): Promise<FileAccessView> {
  if (!actorMayChangeRules(actor)) {
    throw Object.assign(new Error("Only the host can change file access"), {
      status: 403,
      code: "FILE_LOCKED",
      reason: "locked-host",
    });
  }
  const rules = [...(await readRules(projectId))];
  for (const rel of body.delete ?? []) {
    const target = normalizeAccessPath(rel);
    if (isProtectedNormalizedPath(target)) deny(target, "protected");
    const idx = rules.findIndex((rule) => rule.path.toLowerCase() === target.toLowerCase());
    if (idx < 0) continue;
    assertMayLoosen(actor, rules, target, "everyone");
    rules.splice(idx, 1);
  }
  for (const item of body.upsert ?? []) {
    const target = normalizeAccessPath(item.path);
    if (!target) throw Object.assign(new Error("Invalid path"), { status: 400 });
    if (isProtectedNormalizedPath(target)) deny(target, "protected");
    if (item.level !== "everyone" && item.level !== "host" && item.level !== "local") {
      throw Object.assign(new Error("Invalid access level"), { status: 400 });
    }
    assertMayLoosen(actor, rules, target, item.level);
    const idx = rules.findIndex((rule) => rule.path.toLowerCase() === target.toLowerCase());
    if (item.level === "everyone") {
      if (idx >= 0) rules.splice(idx, 1);
      continue;
    }
    const next: FileAccessRule = {
      path: target,
      level: item.level,
      setBy: actor,
      setAt: new Date().toISOString(),
    };
    if (idx >= 0) rules[idx] = next;
    else rules.push(next);
  }
  await writeRules(projectId, rules);
  return { protected: PROTECTED_FILE_PATTERNS, rules };
}

export type TreeNodeWithAccess = TreeNode & {
  access: { canWrite: boolean; reason: FileAccessReason; level: FileAccessLevel; protected: boolean };
  children?: TreeNodeWithAccess[];
};

export async function annotateTreeAccess(
  projectId: string,
  nodes: TreeNode[],
  actor: FileAccessActor,
): Promise<TreeNodeWithAccess[]> {
  const rules = await readRules(projectId);
  async function walk(list: TreeNode[]): Promise<TreeNodeWithAccess[]> {
    const out: TreeNodeWithAccess[] = [];
    for (const node of list) {
      let normalized = node.path;
      try {
        normalized = normalizeAccessPath(node.path);
      } catch {
        normalized = node.path;
      }
      const { targets, escaped } = await targetsFor(projectId, normalized);
      const access = decisionFor(actor, targets, rules, escaped);
      out.push({
        ...node,
        access: {
          canWrite: access.canWrite,
          reason: access.reason,
          level: access.level,
          protected: access.protected,
        },
        children: node.children ? await walk(node.children) : undefined,
      });
    }
    return out;
  }
  return walk(nodes);
}

export function snapshotYjsFiles(doc: Y.Doc): Map<string, string> {
  const files = doc.getMap<Y.Text>("files");
  const snap = new Map<string, string>();
  files.forEach((text, key) => snap.set(key, text.toString()));
  return snap;
}

export function changedYjsFiles(doc: Y.Doc, before: Map<string, string>): string[] {
  const files = doc.getMap<Y.Text>("files");
  const keys = new Set<string>(before.keys());
  files.forEach((_text, key) => keys.add(key));
  const changed: string[] = [];
  for (const key of keys) {
    const current = files.get(key)?.toString();
    if (current !== before.get(key)) changed.push(key);
  }
  return changed;
}

/** Restore Y.Text values the actor is not allowed to change. Returns those paths. */
export async function revertDeniedYjsFiles(
  doc: Y.Doc,
  projectId: string,
  actor: FileAccessActor,
  before: Map<string, string>,
): Promise<string[]> {
  const files = doc.getMap<Y.Text>("files");
  const changed = changedYjsFiles(doc, before);
  const denied: string[] = [];
  for (const key of changed) {
    const access = await effectiveAccess(projectId, key, actor);
    if (!access.canWrite) denied.push(key);
  }
  if (denied.length === 0) return [];
  doc.transact(() => {
    for (const key of denied) {
      const prev = before.get(key);
      if (prev === undefined) {
        files.delete(key);
        continue;
      }
      let text = files.get(key);
      if (!text) {
        text = new Y.Text();
        files.set(key, text);
      }
      if (text.toString() !== prev) {
        text.delete(0, text.length);
        text.insert(0, prev);
      }
    }
  }, "access-revert");
  return denied;
}
