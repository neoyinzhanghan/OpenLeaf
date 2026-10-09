import fs from "node:fs";
import path from "node:path";

/** A compilable document that lives next to openleaf.json, not in a subfolder. */
const ROOT_TEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(?:tex|ltx)$/;

export function isRootLevelTexName(name: string): boolean {
  return ROOT_TEX.test(name);
}

/** True when an uncommented `\documentclass` appears in the source. */
export function sourceHasDocumentClass(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    let code = "";
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === "%" && (i === 0 || line[i - 1] !== "\\")) break;
      code += line[i];
    }
    if (/\\documentclass\b/.test(code)) return true;
  }
  return false;
}

/**
 * Which file this compile should build.
 * An explicit root-level file with `\documentclass` wins over the saved main.
 * A fragment (no `\documentclass`) stays on the saved main.
 * A path that leaves the project root is rejected.
 */
export function compileRootForTree(
  cwd: string,
  requested: string | undefined,
  fallback: string,
): string {
  const raw = requested?.trim().replace(/^\.\//, "");
  if (!raw || raw === fallback) return fallback;
  if (!isRootLevelTexName(raw)) {
    throw Object.assign(new Error("Only a .tex file in the project root can be compiled on its own"), {
      status: 400,
    });
  }
  const abs = path.resolve(cwd, raw);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw Object.assign(new Error("Only a .tex file in the project root can be compiled on its own"), {
      status: 400,
    });
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw Object.assign(new Error(`${raw} was not found in this version`), { status: 404 });
  }
  const text = fs.readFileSync(abs, "utf8");
  if (!sourceHasDocumentClass(text)) return fallback;
  return raw;
}
