/** Root-level .tex the editor can ask the compiler to build instead of the saved main. */
const ROOT_TEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(?:tex|ltx)$/;

export function rootLevelTexCandidate(
  activePath: string | null | undefined,
  savedMain: string | null | undefined,
): string | null {
  if (!activePath) return null;
  const name = activePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const main = savedMain?.trim() || "main.tex";
  if (!name || name === main || name.includes("/")) return null;
  if (!ROOT_TEX.test(name)) return null;
  return name;
}

/**
 * Root to compile for the file now open.
 * A root-level .tex other than the saved main is the request.
 * The saved main returns to that document.
 * An included file keeps the side document already being previewed.
 */
export function nextCompileRoot(opts: {
  activePath: string | null | undefined;
  savedMain: string | null | undefined;
  heldRoot: string | null;
}): { compileRoot: string | null; heldRoot: string | null } {
  const saved = opts.savedMain?.trim() || "main.tex";
  const name = (opts.activePath ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  const candidate = rootLevelTexCandidate(name, saved);
  if (candidate) return { compileRoot: candidate, heldRoot: candidate };
  if (!name || name === saved) return { compileRoot: null, heldRoot: null };
  return { compileRoot: opts.heldRoot, heldRoot: opts.heldRoot };
}
