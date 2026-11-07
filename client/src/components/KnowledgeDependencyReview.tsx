import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  getKnowledgeNeighborhood,
  type KnowledgeGraphNode,
  type KnowledgeStatus,
} from "../api/client";
import { openNodeFromGraph, openNodeHref } from "../lib/knowledgeLinks";

type Props = {
  /** Graph node id, e.g. kn:deephome-us-medicare-ffs-floor */
  nodeId: string;
  /** Optional project folder for “back to write-up”. */
  projectId?: string;
  compact?: boolean;
  onClose?: () => void;
};

function statusLabel(status: KnowledgeStatus): string {
  if (status === "up-to-date" || status === "confirmed" || status === "reviewed") return "OK";
  if (status === "needs-review" || status === "unreviewed") return "Needs review";
  if (status === "flagged") return "Flagged";
  if (status === "rejected" || status === "not_found") return "Rejected";
  return status;
}

function kindLabel(kind: KnowledgeGraphNode["kind"]): string {
  if (kind === "fact") return "Fact";
  if (kind === "source") return "Source";
  if (kind === "knowledge") return "Knowledge";
  if (kind === "project") return "Paper";
  return kind;
}

function reviewOrder(nodes: KnowledgeGraphNode[], rootId: string): KnowledgeGraphNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const root = byId.get(rootId);
  if (!root) return [];
  const upstream = new Set<string>();
  const walk = (id: string) => {
    const n = byId.get(id);
    if (!n) return;
    for (const inp of n.inputs) {
      if (upstream.has(inp)) continue;
      upstream.add(inp);
      walk(inp);
    }
  };
  walk(rootId);
  const rank = (k: KnowledgeGraphNode["kind"]) =>
    k === "source" ? 0 : k === "fact" ? 1 : k === "knowledge" ? 2 : 3;
  return [...upstream]
    .map((id) => byId.get(id)!)
    .filter(Boolean)
    .sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name));
}

export function KnowledgeDependencyReview({ nodeId, projectId, compact, onClose }: Props) {
  const [nodes, setNodes] = useState<KnowledgeGraphNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getKnowledgeNeighborhood(nodeId, 3)
      .then((res) => {
        if (!cancelled) setNodes(res.nodes);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load dependencies");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  const trail = useMemo(() => reviewOrder(nodes, nodeId), [nodes, nodeId]);
  const root = nodes.find((n) => n.id === nodeId) ?? null;
  const needs = trail.filter((n) => {
    const s = n.status;
    return s === "needs-review" || s === "unreviewed" || s === "flagged" || s === "rejected" || s === "not_found";
  });

  return (
    <aside className={`kn-dep-review${compact ? " is-compact" : ""}`} aria-label="Knowledge dependency review">
      <header className="kn-dep-review-head">
        <div>
          <p className="kn-dep-kicker">Review trail</p>
          <h2>{root?.name || "Knowledge"}</h2>
          <p className="kn-dep-lede">
            {loading
              ? "Gathering sources and facts this write-up builds on…"
              : trail.length
                ? `${trail.length} dependenc${trail.length === 1 ? "y" : "ies"} · ${needs.length} need attention`
                : "No upstream dependencies indexed yet."}
          </p>
        </div>
        {onClose ? (
          <button type="button" className="btn btn-ghost btn-quiet" onClick={onClose}>
            Close
          </button>
        ) : null}
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <ol className="kn-dep-trail">
        {trail.map((n, i) => {
          const href = openNodeHref(n);
          const attention =
            n.status === "needs-review" ||
            n.status === "unreviewed" ||
            n.status === "flagged" ||
            n.status === "rejected" ||
            n.status === "not_found";
          return (
            <li key={n.id} className={attention ? "is-attention" : undefined}>
              <span className="kn-dep-step">{i + 1}</span>
              <span className="knowledge-kind-dot" data-kind={n.kind} />
              <div className="kn-dep-copy">
                <strong>{n.name}</strong>
                <span className="kn-dep-meta">
                  {kindLabel(n.kind)}
                  {n.citekey ? ` · ${n.citekey}` : ""}
                  {n.factKey ? ` · \\fact{${n.factKey}}` : ""}
                </span>
                {n.note && n.kind === "fact" ? <span className="kn-dep-note">{n.note}</span> : null}
              </div>
              <span className={`knowledge-status-chip${attention ? " is-needs" : ""}`}>
                {statusLabel(n.status)}
              </span>
              {href ? (
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => openNodeFromGraph(href)}
                >
                  {n.kind === "fact" ? "See source" : n.kind === "source" ? "Open source" : "Open"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>

      {!loading && !trail.length && !error ? (
        <p className="kn-dep-empty">This item does not cite facts or other knowledge yet.</p>
      ) : null}

      <footer className="kn-dep-foot">
        <p>
          Confirm each fact against its source, then return to the write-up. The conclusion should only stand if every
          dependency above is sound.
        </p>
        <div className="kn-dep-foot-actions">
          {projectId ? (
            <Link className="btn btn-primary" to={`/p/${encodeURIComponent(projectId)}`}>
              Back to write-up
            </Link>
          ) : null}
          <Link className="btn btn-quiet" to={`/knowledge?focus=${encodeURIComponent(nodeId)}`}>
            View on graph
          </Link>
        </div>
      </footer>
    </aside>
  );
}
