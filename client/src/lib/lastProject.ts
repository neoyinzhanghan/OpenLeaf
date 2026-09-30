const KEY = "openleaf.lastProject";

export type LastProject = { id: string; name: string };

export function rememberProject(project: LastProject): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(project));
  } catch {
    /* private mode */
  }
}

export function readLastProject(): LastProject | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastProject>;
    if (!parsed.id) return null;
    return { id: parsed.id, name: parsed.name || parsed.id };
  } catch {
    return null;
  }
}
