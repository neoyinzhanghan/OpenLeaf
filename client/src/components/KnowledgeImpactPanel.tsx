import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getKnowledgeImpact, type KnowledgeGraphNode, type KnowledgeImpact } from "../api/client";

function openHref(node: KnowledgeGraphNode): string | null {
  if (node.kind === "knowledge") {
    return `/knowledge?focus=${encodeURIComponent(node.id)}`;
  }
  if (node.kind === "project") {
    const id = node.id.startsWith("proj:") ? node.id.slice(5) : node.id;
    return `/p/${encodeURIComponent(id)}`;
  }
  if (node.kind === "fact") {
    return `/facts?q=${encodeURIComponent(node.name)}`;
  }
  if (node.kind === "source") {
    const citekey = node.id.startsWith("src:") ? node.id.slice(4) : node.id;
    return `/library?paper=${encodeURIComponent(citekey)}`;
  }
  return null;
}

export function KnowledgeImpactPanel({
  nodeId,
  onClose,
}: {
  nodeId: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<KnowledgeImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!nodeId) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getKnowledgeImpact(nodeId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load impact");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  if (!nodeId) return null;

  const flagged = data?.flagged ?? [];
  const count = flagged.length;

  return (
    <>
      <button type="button" className="knowledge-impact-backdrop" aria-label="Close impact" onClick={onClose} />
      <aside className="knowledge-impact-drawer" role="dialog" aria-labelledby="knowledge-impact-title">
        <header>
          <div>
            <h2 id="knowledge-impact-title">
              {loading ? "Checking impact…" : `${count} thing${count === 1 ? "" : "s"} built on it ${count === 1 ? "is" : "are"} now flagged`}
            </h2>
            <p className="review-row-meta" style={{ margin: "0.35rem 0 0" }}>
              Source node <code>{nodeId}</code>
              {data ? ` · ${data.notAffectedCount} not affected` : null}
            </p>
          </div>
          <button type="button" className="btn btn-ghost btn-quiet" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="knowledge-impact-body">
          {error ? <div className="error-banner">{error}</div> : null}
          {!loading && !error && flagged.length === 0 ? (
            <p className="empty-hint">Nothing downstream is flagged yet.</p>
          ) : null}
          <ul className="knowledge-impact-chain">
            {flagged.map((n) => {
              const href = openHref(n);
              return (
                <li key={n.id}>
                  <div>
                    <span className="knowledge-kind-dot" data-kind={n.kind} />
                    <strong>{n.name}</strong>{" "}
                    <span className={`knowledge-status-chip is-${n.status === "rejected" ? "reject" : n.status === "flagged" ? "flag" : "needs"}`}>
                      {n.status}
                    </span>
                  </div>
                  {n.why.length ? <div className="why">{n.why.join(" · ")}</div> : null}
                  {href ? (
                    <div style={{ marginTop: "0.35rem" }}>
                      <Link to={href} className="btn btn-quiet" onClick={onClose}>
                        Open
                      </Link>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
    </>
  );
}
