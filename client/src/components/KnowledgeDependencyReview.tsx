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
  /** When true, trail sits beside the write-up — hide redundant “Back to write-up”. */
  compact?: boolean;
  onClose?: () => void;
};

function statusLabel(kind: KnowledgeGraphNode["kind"], status: KnowledgeStatus): string | null {
  // Sources are not reviewed — never show an OK badge on them.
  if (kind === "source") return null;
  if (status === "up-to-date" || status === "confirmed" || status === "reviewed") return "Checked";
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

function statusChipClass(status: KnowledgeStatus): string {
  if (status === "rejected" || status === "not_found") return "is-reject";
  if (status === "flagged") return "is-flag";
  if (status === "needs-review" || status === "unreviewed") return "is-needs";
  return "is-ok";
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
  const [guided, setGuided] = useState(false);
  const [guidedIdx, setGuidedIdx] = useState(0);

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
    if (n.kind === "source") return false;
    const s = n.status;
    return s === "needs-review" || s === "unreviewed" || s === "flagged" || s === "rejected" || s === "not_found";
  });
  const trustLine = root
    ? `Built on ${trail.filter((n) => n.kind === "fact").length} facts and ${
        trail.filter((n) => n.kind === "knowledge").length
      } knowledge items · ${needs.length} need attention`
    : null;

  const guidedCards = needs.length ? needs : trail.filter((n) => n.kind === "fact" || n.kind === "knowledge");
  const guidedCard = guidedCards[Math.min(guidedIdx, Math.max(0, guidedCards.length - 1))] ?? null;
  const trusted = !loading && needs.length === 0 && trail.length > 0;

  useEffect(() => {
    if (!guided) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "j" || e.key === "ArrowRight") {
        e.preventDefault();
        setGuidedIdx((i) => Math.min(guidedCards.length - 1, i + 1));
      } else if (e.key === "k" || e.key === "ArrowLeft") {
        e.preventDefault();
        setGuidedIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Escape") {
        setGuided(false);
        setGuidedIdx(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [guided, guidedCards.length]);

  return (
    <aside className={`kn-dep-review${compact ? " is-compact" : ""}`} aria-label="Knowledge dependency review">
      <header className="kn-dep-review-head">
        <div>
          <p className="kn-dep-kicker">Review trail</p>
          <h2 title={root?.name || "Knowledge"}>{root?.name || "Knowledge"}</h2>
          <p className="kn-dep-lede">
            {loading
              ? "Gathering sources and facts this write-up builds on…"
              : trustLine || "No upstream dependencies indexed yet."}
          </p>
        </div>
        {onClose ? (
          <button type="button" className="btn btn-ghost btn-quiet" onClick={onClose}>
            {compact ? "Show files" : "Close"}
          </button>
        ) : null}
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      {trusted ? (
        <p className="kn-dep-trusted" role="status">
          This item is now trusted — every dependency above is checked and clean.
        </p>
      ) : null}

      {!loading && guidedCards.length > 0 ? (
        <div className="kn-dep-guided-bar">
          {guided ? (
            <>
              <div className="kn-dep-progress" aria-hidden>
                <span style={{ width: `${((guidedIdx + 1) / guidedCards.length) * 100}%` }} />
              </div>
              <p className="kn-dep-guided-meta">
                Card {guidedIdx + 1} of {guidedCards.length}
                {guidedCard ? ` · ${kindLabel(guidedCard.kind)}` : ""}
              </p>
              {guidedCard ? (
                <div className="kn-dep-guided-card">
                  <strong title={guidedCard.name}>{guidedCard.name}</strong>
                  <span className="muted">
                    {statusLabel(guidedCard.kind, guidedCard.status) || kindLabel(guidedCard.kind)}
                    {guidedCard.why?.[0] ? ` — ${guidedCard.why[0]}` : ""}
                  </span>
                  <div className="kn-dep-foot-actions">
                    {openNodeHref(guidedCard) ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => openNodeFromGraph(openNodeHref(guidedCard)!)}
                      >
                        {guidedCard.kind === "fact" ? "See source" : "Open"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-quiet"
                      disabled={guidedIdx <= 0}
                      onClick={() => setGuidedIdx((i) => Math.max(0, i - 1))}
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={() => {
                        if (guidedIdx >= guidedCards.length - 1) {
                          setGuided(false);
                          setGuidedIdx(0);
                        } else setGuidedIdx((i) => i + 1);
                      }}
                    >
                      {guidedIdx >= guidedCards.length - 1 ? "Done" : "Next"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setGuided(false);
                        setGuidedIdx(0);
                      }}
                    >
                      Exit
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setGuided(true);
                setGuidedIdx(0);
              }}
            >
              Start guided review
            </button>
          )}
        </div>
      ) : null}

      <ol className={`kn-dep-trail${guided ? " is-dimmed" : ""}`}>
        {trail.map((n, i) => {
          const href = openNodeHref(n);
          const label = statusLabel(n.kind, n.status);
          const attention =
            n.kind !== "source" &&
            (n.status === "needs-review" ||
              n.status === "unreviewed" ||
              n.status === "flagged" ||
              n.status === "rejected" ||
              n.status === "not_found");
          return (
            <li key={n.id} className={attention ? "is-attention" : undefined}>
              <div className="kn-dep-trail-top">
                <span className="kn-dep-step">{i + 1}</span>
                <span className="knowledge-kind-dot" data-kind={n.kind} />
                <div className="kn-dep-copy">
                  <strong title={n.name}>{n.name}</strong>
                  <span className="kn-dep-meta">
                    {kindLabel(n.kind)}
                    {n.why?.[0] ? ` · ${n.why[0]}` : ""}
                  </span>
                  {n.note && n.kind === "fact" ? <span className="kn-dep-note">{n.note}</span> : null}
                </div>
              </div>
              <div className="kn-dep-trail-actions">
                {label ? (
                  <span className={`knowledge-status-chip ${statusChipClass(n.status)}`}>{label}</span>
                ) : (
                  <span className="kn-dep-source-badge">Source</span>
                )}
                {href ? (
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => openNodeFromGraph(href)}
                  >
                    {n.kind === "fact" ? "See source" : n.kind === "source" ? "Open source" : "Open"}
                  </button>
                ) : null}
              </div>
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
          {!compact && projectId ? (
            <Link className="btn btn-primary" to={`/p/${encodeURIComponent(projectId)}`}>
              Back to write-up
            </Link>
          ) : null}
          {compact && onClose ? (
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Done — show files
            </button>
          ) : null}
          <Link className="btn btn-quiet" to={`/knowledge?focus=${encodeURIComponent(nodeId)}`}>
            View on graph
          </Link>
        </div>
      </footer>
    </aside>
  );
}
