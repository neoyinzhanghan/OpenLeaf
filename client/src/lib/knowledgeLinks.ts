import type { KnowledgeGraphNode } from "../api/client";

/** Parse `library/papers/<citekey>/facts.json#<factId>` → ids for Facts deep links. */
export function parseFactPathRef(pathRef: string | undefined): { citekey: string; factId: string } | null {
  if (!pathRef) return null;
  const m = pathRef.match(/^library\/papers\/([^/]+)\/facts\.json#(.+)$/);
  if (!m) return null;
  return { citekey: m[1]!, factId: m[2]! };
}

/**
 * Deep-link into the right review surface. Facts always include paper + fact id and
 * widen filters so confirmed web facts are not hidden behind the unreviewed default.
 */
export function openNodeHref(
  node: KnowledgeGraphNode,
  projectByKn?: Map<string, string>,
): string | null {
  if (node.kind === "knowledge") {
    const kn = node.knowledgeId || (node.id.startsWith("kn:") ? node.id.slice(3) : node.id);
    const projectId = node.projectId || projectByKn?.get(kn);
    if (!projectId) return `/knowledge?focus=${encodeURIComponent(node.id)}`;
    return `/p/${encodeURIComponent(projectId)}?review=1`;
  }
  if (node.kind === "project") {
    const id = node.projectId || (node.id.startsWith("proj:") ? node.id.slice(5) : node.id);
    return `/p/${encodeURIComponent(id)}`;
  }
  if (node.kind === "fact") {
    const parsed = parseFactPathRef(node.pathRef);
    const citekey = node.citekey || parsed?.citekey;
    const factId = parsed?.factId;
    if (citekey && factId) {
      return `/facts?paper=${encodeURIComponent(citekey)}&fact=${encodeURIComponent(factId)}&status=all&type=all`;
    }
    if (citekey) {
      return `/facts?paper=${encodeURIComponent(citekey)}&status=all&type=all`;
    }
    if (node.factKey) {
      return `/facts?q=${encodeURIComponent(node.factKey)}&status=all&type=all`;
    }
    return `/facts?q=${encodeURIComponent(node.name)}&status=all&type=all`;
  }
  if (node.kind === "source") {
    const citekey = node.citekey || (node.id.startsWith("src:") ? node.id.slice(4) : node.id);
    return `/library?paper=${encodeURIComponent(citekey)}`;
  }
  return null;
}

export function openNodeFromGraph(href: string) {
  window.open(href, "_blank", "noopener,noreferrer");
}
