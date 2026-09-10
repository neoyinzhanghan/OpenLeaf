import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getProjectTimeline } from "../api/client";
import type { TimelineBranch, TimelineNode, TimelineView } from "../api/types";
import { TimelineGraph } from "./TimelineGraph";
import { formatWhen } from "./timelineLayout";

type Props = {
  projectId: string;
  open: boolean;
  selectedHash: string | null;
  onClose: () => void;
  onPick: (node: TimelineNode, branch: TimelineBranch) => void;
};

export function CompareBaselinePicker({ projectId, open, selectedHash, onClose, onPick }: Props) {
  const [view, setView] = useState<TimelineView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recenterToken, setRecenterToken] = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setView(await getProjectTimeline(projectId));
      setRecenterToken((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load timeline");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const selectedId =
    view?.nodes.find((n) => n.gitHash === selectedHash || n.gitHash.startsWith(selectedHash ?? "\0"))?.id ??
    null;

  return createPortal(
    <aside
      className="history-drawer timeline-drawer share-pick-drawer"
      role="dialog"
      aria-modal="true"
      aria-label="Compare to a leaf"
    >
      <div className="history-drawer-head">
        <strong>
          Compare to…
          {view ? ` · ${view.nodes.length} leaf${view.nodes.length === 1 ? "" : "ves"}` : ""}
        </strong>
        <div className="history-drawer-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setRecenterToken((n) => n + 1)}
            disabled={loading}
          >
            Recenter
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void refresh()} disabled={loading}>
            Refresh
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      <p className="history-hint timeline-hint">
        Pick a leaf as the baseline. Differences highlight what changed between that leaf and what you’re viewing
        now (live tip or another checkpoint).
      </p>

      {error && <div className="error-banner">{error}</div>}

      <TimelineGraph
        view={view}
        loading={loading}
        selectedId={selectedId}
        recenterToken={recenterToken}
        emptyLabel="No leaves yet — Commit on the timeline first."
        onNodeClick={(node, branch) => {
          onPick(node, branch);
          onClose();
        }}
      >
        {selectedId && view && (
          <div className="tl-hover-dock">
            <div className="tl-hover-dock-main">
              {(() => {
                const n = view.nodes.find((x) => x.id === selectedId);
                const b = n && view.branches.find((x) => x.id === n.branchId);
                if (!n || !b) return null;
                return (
                  <>
                    <div className="tl-card-kicker">
                      <span>{b.name}</span>
                      <span className="tl-chip">compare to</span>
                    </div>
                    <div className="tl-card-title">{n.message}</div>
                    <div className="tl-card-meta">
                      <code>{n.gitHash.slice(0, 7)}</code>
                      <span>{n.author}</span>
                      <span>{formatWhen(n.createdAt)}</span>
                    </div>
                  </>
                );
              })()}
            </div>
            <p className="share-muted" style={{ margin: 0, fontSize: "0.78rem" }}>
              Click another leaf to change the baseline.
            </p>
          </div>
        )}
      </TimelineGraph>
    </aside>,
    document.body,
  );
}
