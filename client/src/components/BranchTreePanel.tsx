import { useCallback, useEffect, useMemo, useState } from "react";
import {
  checkoutProjectTimeline,
  commitProjectTimeline,
  deleteProjectTimelineTrashForever,
  forkProjectTimeline,
  getBranchLeaves,
  getProjectTimeline,
  listProjectTimelineTrash,
  pruneProjectTimelineTip,
  startProjectMerge,
  unpruneProjectTimelineTip,
  type BranchLeafStat,
  type PrunedTipInfo,
} from "../api/client";
import type { TimelineBranch, TimelineNode, TimelineView } from "../api/types";
import { TimelineGraph } from "./TimelineGraph";
import { AgentTrajectoryWindow } from "./AgentTrajectoryWindow";
import { formatWhen } from "./timelineLayout";

type Props = {
  projectId: string;
  identityId?: string;
  open: boolean;
  onClose: () => void;
  onTimelineChange: (view: TimelineView) => void;
  canFork?: boolean;
  canCheckout?: boolean;
  canMerge?: boolean;
  canPrune?: boolean;
  onMergeStarted?: (session: import("../api/client").MergeSession) => void;
  guestBranchId?: string | null;
  leavesVersion?: number;
  onHighlightSince?: (gitHash: string) => void;
};

export function BranchTreePanel({
  projectId,
  identityId,
  open,
  onClose,
  onTimelineChange,
  canFork = true,
  canCheckout = true,
  canMerge = false,
  canPrune = true,
  onMergeStarted,
  guestBranchId = null,
  leavesVersion = 0,
  onHighlightSince,
}: Props) {
  const [view, setView] = useState<TimelineView | null>(null);
  const [leafStats, setLeafStats] = useState<BranchLeafStat[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forkFrom, setForkFrom] = useState<TimelineNode | null>(null);
  const [forkName, setForkName] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [recenterToken, setRecenterToken] = useState(0);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trash, setTrash] = useState<PrunedTipInfo[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<PrunedTipInfo | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [mergeTarget, setMergeTarget] = useState<{ id: string; name: string } | null>(null);
  const [trajOpen, setTrajOpen] = useState(false);

  /** Stick the hover dock so actions (Prune, etc.) remain clickable. */
  const keepDock = useCallback((id: string | null) => {
    if (id != null) setHoveredId(id);
  }, []);

  const dismissDock = useCallback(() => {
    setHoveredId(null);
  }, []);

  useEffect(() => {
    if (!open || !hoveredId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismissDock();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest(".tl-hover-dock, .tl-orb, .tl-fork-modal, .tl-trash-delete-modal, .tl-trash-panel, .traj-window")) {
        return;
      }
      dismissDock();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, hoveredId, dismissDock]);

  const refreshLeaves = useCallback(async () => {
    try {
      setLeafStats(await getBranchLeaves(projectId));
    } catch {
      /* optional */
    }
  }, [projectId]);

  const refreshTrash = useCallback(async () => {
    if (guestBranchId) {
      setTrash([]);
      return;
    }
    try {
      const r = await listProjectTimelineTrash(projectId);
      setTrash(r.items);
    } catch {
      setTrash([]);
    }
  }, [projectId, guestBranchId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setView(await getProjectTimeline(projectId, guestBranchId ?? undefined));
      await Promise.all([refreshLeaves(), refreshTrash()]);
      setRecenterToken((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load timeline");
    } finally {
      setLoading(false);
    }
  }, [projectId, guestBranchId, refreshLeaves, refreshTrash]);

  useEffect(() => {
    if (open) void refresh();
    else setTrajOpen(false);
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => {
      void (async () => {
        try {
          const next = await getProjectTimeline(projectId, guestBranchId ?? undefined);
          setView(next);
          await Promise.all([refreshLeaves(), refreshTrash()]);
        } catch {
          /* keep last view */
        }
      })();
    }, 4000);
    return () => window.clearInterval(t);
  }, [open, projectId, guestBranchId, refreshLeaves, refreshTrash]);

  useEffect(() => {
    if (!open || !leavesVersion) return;
    void refreshLeaves();
  }, [open, leavesVersion, refreshLeaves]);

  const leafByBranch = useMemo(() => {
    const m = new Map<string, BranchLeafStat>();
    for (const s of leafStats) m.set(s.branchId, s);
    return m;
  }, [leafStats]);

  const activeId = view?.viewingNodeId ?? view?.activeBranch.headNodeId ?? null;
  const hotId = hoveredId ?? pinnedId ?? activeId;
  const hover = hoveredId && view ? view.nodes.find((n) => n.id === hoveredId) : null;
  const hoverBranch =
    hover && view ? view.branches.find((b) => b.id === hover.branchId) ?? null : null;
  const selectedNode =
    (pinnedId && view?.nodes.find((n) => n.id === pinnedId)) ||
    (activeId && view?.nodes.find((n) => n.id === activeId)) ||
    null;

  const selectNode = async (node: TimelineNode, branch: TimelineBranch) => {
    setBusy(true);
    setError(null);
    setPinnedId(node.id);
    try {
      const isTip = branch.headNodeId === node.id;
      if (guestBranchId) {
        if (!isTip) {
          setError("Share-link guests can open live tips only — ask the host to travel history");
          return;
        }
        const next = await getProjectTimeline(projectId, branch.id);
        setView(next);
        onTimelineChange(next);
        return;
      }
      if (!canCheckout) return;
      const next = await checkoutProjectTimeline(projectId, {
        branchId: branch.id,
        nodeId: isTip ? null : node.id,
      });
      setView(next);
      onTimelineChange(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that leaf");
    } finally {
      setBusy(false);
    }
  };

  const onFork = async () => {
    if (!forkFrom || !forkName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await forkProjectTimeline(projectId, {
        fromNodeId: forkFrom.id,
        name: forkName.trim(),
      });
      setForkFrom(null);
      setForkName("");
      setView(result.timeline);
      onTimelineChange(result.timeline);
      setRecenterToken((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fork failed");
    } finally {
      setBusy(false);
    }
  };

  const applyTimeline = (timeline: TimelineView) => {
    setView(timeline);
    onTimelineChange(timeline);
    setRecenterToken((n) => n + 1);
  };

  const onPruneTip = async (branch: TimelineBranch) => {
    const isAi = branch.name.startsWith("ai/") || branch.id.startsWith("ai/");
    const lines = [
      `Prune tip “${branch.name}”?`,
      "",
      "It moves to Trash (hidden, recoverable). Delete forever is a separate step.",
      "",
      "Normally blocked while a public share, live AI link, or connected editor is on this tip.",
      "If editors are still connected, you can force-prune next — that kicks everyone (including you).",
    ];
    if (isAi) {
      lines.push("", "This looks like an AI sandbox — revoke the AI link before pruning if the link is still live.");
    }
    if (!window.confirm(lines.join("\n"))) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let result: { timeline: TimelineView };
      try {
        result = await pruneProjectTimelineTip(projectId, { branchId: branch.id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Could not prune tip";
        if (!/still connected to this tip/i.test(msg)) throw err;
        const force = window.confirm(
          [
            msg,
            "",
            "Force prune anyway?",
            "This disconnects everyone still on this tip (including you) and moves it to Trash.",
            "Public shares and live AI links still must be revoked first.",
          ].join("\n"),
        );
        if (!force) {
          setError(msg);
          return;
        }
        result = await pruneProjectTimelineTip(projectId, {
          branchId: branch.id,
          forceKickEditors: true,
        });
      }
      applyTimeline(result.timeline);
      setHoveredId(null);
      setPinnedId(null);
      await refreshTrash();
      setTrashOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not prune tip");
    } finally {
      setBusy(false);
    }
  };

  const onRestoreTip = async (item: PrunedTipInfo) => {
    setBusy(true);
    setError(null);
    try {
      const result = await unpruneProjectTimelineTip(projectId, { branchId: item.branchId });
      setView(result.timeline);
      onTimelineChange(result.timeline);
      setRecenterToken((n) => n + 1);
      await refreshTrash();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restore tip");
    } finally {
      setBusy(false);
    }
  };

  const onDeleteForever = async () => {
    if (!deleteTarget) return;
    if (deleteConfirm.trim() !== deleteTarget.name) {
      setError(`Type “${deleteTarget.name}” exactly to delete forever`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Typed name is the confirmation: kick leftover rooms and discard uncommitted
      // worktree edits so delete forever cannot hang behind soft gates.
      const result = await deleteProjectTimelineTrashForever(projectId, {
        branchId: deleteTarget.branchId,
        confirmName: deleteConfirm.trim(),
        forceKickEditors: true,
        discardDirty: true,
      });
      applyTimeline(result.timeline);
      setDeleteTarget(null);
      setDeleteConfirm("");
      await refreshTrash();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete tip");
    } finally {
      setBusy(false);
    }
  };

  const onCommit = async () => {
    if (!commitMsg.trim() || !view) return;
    setBusy(true);
    setError(null);
    try {
      const result = await commitProjectTimeline(projectId, {
        message: commitMsg.trim(),
        branchId: view.activeBranchId,
        identityId,
      });
      setCommitMsg("");
      setView(result.timeline);
      onTimelineChange(result.timeline);
      setRecenterToken((n) => n + 1);
      await refreshLeaves();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Commit failed");
    } finally {
      setBusy(false);
    }
  };

  const openMergePreflight = (sourceBranchId: string, sourceName: string) => {
    if (!view || !onMergeStarted) return;
    if (!view.canEdit) {
      setError("Open your editable tip first — merge lands on the tip you’re currently editing");
      return;
    }
    if (sourceBranchId === view.activeBranchId) {
      setError("Pick another branch tip to merge into the current leaf");
      return;
    }
    setError(null);
    setMergeTarget({ id: sourceBranchId, name: sourceName });
  };

  const confirmMergeIntoCurrent = async () => {
    if (!view || !onMergeStarted || !mergeTarget) return;
    if (view.dirty) {
      setError("Commit or discard local edits on the current tip before merging");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await startProjectMerge(projectId, {
        sourceBranchId: mergeTarget.id,
        targetBranchId: view.activeBranchId,
      });
      setMergeTarget(null);
      onMergeStarted(session);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Merge failed to start");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const hoverIsHead = Boolean(hoverBranch && hover && hoverBranch.headNodeId === hover.id);
  const hoverIsSacred = Boolean(hoverBranch?.sacred);
  const hoverIsAi = Boolean(hoverBranch?.name.startsWith("ai/"));
  const showTrash = canPrune && !guestBranchId;

  return (
    <aside className="history-drawer timeline-drawer" aria-label="Branch timeline">
      <div className="history-drawer-head">
        <strong>
          Sacred timeline
          {view ? ` · ${view.nodes.length} leaf${view.nodes.length === 1 ? "" : "ves"}` : ""}
        </strong>
        <div className="history-drawer-actions">
          <button
            type="button"
            className={`btn btn-ghost${trajOpen ? " is-active" : ""}`}
            disabled={!selectedNode || loading}
            title={
              selectedNode
                ? `View agent sessions first included by ${selectedNode.gitHash.slice(0, 7)}`
                : "Select a commit on the timeline first"
            }
            onClick={() => setTrajOpen((v) => !v)}
          >
            View agent trajectory
          </button>
          {showTrash && (
            <button
              type="button"
              className={`btn btn-ghost btn-icon tl-trash-btn${trashOpen ? " is-active" : ""}`}
              onClick={() => setTrashOpen((v) => !v)}
              disabled={loading}
              title={trash.length > 0 ? `Trash · ${trash.length} pruned tip${trash.length === 1 ? "" : "s"}` : "Trash"}
              aria-label={trash.length > 0 ? `Trash, ${trash.length} items` : "Trash"}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M4 7h16" strokeLinecap="round" />
                <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M10 11v6M14 11v6" strokeLinecap="round" />
              </svg>
              {trash.length > 0 && <span className="tl-trash-count">{trash.length}</span>}
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => setRecenterToken((n) => n + 1)}
            disabled={loading}
            title="Recenter"
            aria-label="Recenter"
          >
            ⌖
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => void refresh()}
            disabled={loading}
            title="Refresh"
            aria-label="Refresh"
          >
            ↻
          </button>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} title="Close" aria-label="Close">
            ✕
          </button>
        </div>
      </div>

      <p className="history-hint timeline-hint">
        Time left → right. Hover a tip for actions. To merge: stay on the tip that should receive changes, then hover
        another tip → <em>Merge in</em>. Host-only prune moves tips to Trash. Agent and CLI git commits appear here
        automatically.
      </p>

      {error && <div className="error-banner">{error}</div>}

      {showTrash && trashOpen && (
        <div className="tl-trash-panel" role="region" aria-label="Pruned tips trash">
          <div className="tl-trash-head">
            <strong>Trash</strong>
            <span className="share-muted">Pruned tips — hidden, not deleted yet</span>
          </div>
          {trash.length === 0 ? (
            <p className="share-muted share-pad">Trash is empty.</p>
          ) : (
            <ul className="tl-trash-list">
              {trash.map((item) => (
                <li key={item.branchId}>
                  <div className="tl-trash-item-main">
                    <code>{item.name}</code>
                    <span className="share-muted">
                      pruned {formatWhen(item.prunedAt)}
                      {item.tipHash ? ` · ${item.tipHash.slice(0, 7)}` : ""}
                      {` · ${item.nodeCount} leaf${item.nodeCount === 1 ? "" : "ves"}`}
                    </span>
                    {item.tipMessage && <div className="tl-trash-msg">{item.tipMessage}</div>}
                  </div>
                  <div className="tl-trash-item-actions">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy}
                      onClick={() => void onRestoreTip(item)}
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={busy}
                      onClick={() => {
                        setDeleteTarget(item);
                        setDeleteConfirm("");
                        setError(null);
                      }}
                    >
                      Delete forever…
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {view &&
        view.canEdit &&
        (!guestBranchId || view.activeBranchId === guestBranchId) && (
          <div className="timeline-commit-row">
            <input
              type="text"
              placeholder={`Commit on ${view.activeBranch.name}…`}
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              disabled={busy}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !commitMsg.trim()}
              onClick={() => void onCommit()}
            >
              Commit
            </button>
          </div>
        )}

      <TimelineGraph
        view={view}
        loading={loading}
        selectedId={activeId}
        hotId={hotId}
        leafByBranch={leafByBranch}
        recenterToken={recenterToken}
        busy={busy}
        emptyLabel="No leaves yet — commit on a tip to begin."
        onHoverIdChange={keepDock}
        onNodeClick={(node, branch) => void selectNode(node, branch)}
      >
        {hover && hoverBranch && (
          <div
            className={`tl-hover-dock${hoverIsSacred ? " is-sacred" : ""}${hoverIsAi ? " is-ai" : ""}`}
            onMouseEnter={() => keepDock(hover.id)}
          >
            <div className="tl-hover-dock-main">
              <div className="tl-card-title">{hover.message || "Untitled leaf"}</div>
              <div className="tl-card-meta">
                <span className="tl-card-branch">{hoverBranch.name}</span>
                {hoverIsHead && <span>tip</span>}
                {hoverIsAi && <span>AI</span>}
                {hover.legacy && <span>legacy</span>}
                {hoverIsHead && leafByBranch.get(hoverBranch.id)?.dirty && (
                  <span className="tl-meta-dirty">
                    +{leafByBranch.get(hoverBranch.id)!.additions} −
                    {leafByBranch.get(hoverBranch.id)!.deletions}
                  </span>
                )}
                <span className="tl-meta-sep" aria-hidden>
                  ·
                </span>
                <code>{hover.gitHash.slice(0, 7)}</code>
                <span>{hover.author}</span>
                <span>{formatWhen(hover.createdAt)}</span>
              </div>
            </div>
            <div className="tl-card-actions">
              {canCheckout && !guestBranchId && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => void selectNode(hover, hoverBranch)}
                >
                  {hover.id === activeId ? "Here" : "Open"}
                </button>
              )}
              {guestBranchId && hoverIsHead && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => void selectNode(hover, hoverBranch)}
                >
                  {hoverBranch.id === guestBranchId
                    ? hover.id === activeId
                      ? "Here"
                      : "Return"
                    : "Observe"}
                </button>
              )}
              {canFork && !guestBranchId && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setForkFrom(hover);
                    setForkName("");
                  }}
                >
                  Fork
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setPinnedId(hover.id);
                  setTrajOpen(true);
                }}
              >
                Agent sessions
              </button>
              {canMerge &&
                !guestBranchId &&
                hoverIsHead &&
                view?.canEdit &&
                hoverBranch.id !== view.activeBranchId && (
                  <button
                    type="button"
                    className="btn btn-ghost tl-merge-btn"
                    disabled={busy}
                    title={`Merge “${hoverBranch.name}” into your current tip “${view.activeBranch.name}”`}
                    onClick={() => openMergePreflight(hoverBranch.id, hoverBranch.name)}
                  >
                    Merge in
                  </button>
                )}
              {canPrune &&
                !guestBranchId &&
                hoverIsHead &&
                !hoverIsSacred &&
                hoverBranch.id !== "main" && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy}
                    title="Move this tip to the trash (soft hide)"
                    onClick={() => void onPruneTip(hoverBranch)}
                  >
                    Prune
                  </button>
                )}
              {onHighlightSince && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    onHighlightSince(hover.gitHash);
                    onClose();
                  }}
                >
                  Compare
                </button>
              )}
            </div>
          </div>
        )}
      </TimelineGraph>

      {forkFrom && (
        <div className="tl-fork-modal timeline-fork-modal" role="dialog">
          <strong>Fork a new thread</strong>
          <p className="share-muted">
            Name the branch that peels away from “{forkFrom.message.slice(0, 60)}”. You’ll land on its editable tip.
          </p>
          <input
            type="text"
            placeholder="Branch name (e.g. methods-rewrite)"
            value={forkName}
            onChange={(e) => setForkName(e.target.value)}
            autoFocus
          />
          <div className="history-drawer-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setForkFrom(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !forkName.trim()}
              onClick={() => void onFork()}
            >
              Create branch
            </button>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="tl-fork-modal timeline-fork-modal tl-trash-delete-modal" role="dialog" aria-modal="true">
          <strong>Delete forever</strong>
          <p className="share-muted">
            This permanently removes tip <code>{deleteTarget.name}</code> from the timeline, deletes its worktree, and
            drops the git branch. Typing the name discards any leftover uncommitted edits and kicks stray editors on
            this tip. Still blocked while a public share or live AI link remains — revoke those first. Cannot be undone.
          </p>
          <label className="tl-trash-confirm-label">
            Type <code>{deleteTarget.name}</code> to confirm
            <input
              type="text"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder={deleteTarget.name}
              autoFocus
              disabled={busy}
            />
          </label>
          <div className="history-drawer-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                setDeleteTarget(null);
                setDeleteConfirm("");
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy || deleteConfirm.trim() !== deleteTarget.name}
              onClick={() => void onDeleteForever()}
            >
              {busy ? "Deleting…" : "Delete forever"}
            </button>
          </div>
        </div>
      )}

      {mergeTarget && view && (
        <div className="tl-fork-modal timeline-fork-modal tl-merge-modal" role="dialog" aria-modal="true">
          <strong>Merge into current tip</strong>
          <div className="merge-flow tl-merge-flow" aria-label="Merge direction">
            <span className="merge-flow-chip is-source">{mergeTarget.name}</span>
            <span className="merge-flow-arrow" aria-hidden>
              →
            </span>
            <span className="merge-flow-chip is-target">{view.activeBranch.name}</span>
          </div>
          <p className="share-muted">
            Incoming changes from <code>{mergeTarget.name}</code> land on your current tip{" "}
            <code>{view.activeBranch.name}</code>. You’ll review any conflicts before completing.
          </p>
          <ul className="tl-merge-checklist">
            <li className={view.canEdit ? "is-ok" : "is-bad"}>
              {view.canEdit ? "Editing an open tip" : "Not on an editable tip — open your tip first"}
            </li>
            <li className={!view.dirty ? "is-ok" : "is-bad"}>
              {!view.dirty
                ? "Working tree is clean"
                : "Uncommitted edits on this tip — commit or discard first"}
            </li>
          </ul>
          <div className="history-drawer-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => setMergeTarget(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !view.canEdit || view.dirty}
              onClick={() => void confirmMergeIntoCurrent()}
            >
              {busy ? "Starting…" : "Start merge"}
            </button>
          </div>
        </div>
      )}
      <AgentTrajectoryWindow
        projectId={projectId}
        open={open && trajOpen}
        node={selectedNode}
        onClose={() => setTrajOpen(false)}
      />
    </aside>
  );
}
