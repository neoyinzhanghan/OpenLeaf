import { useCallback, useEffect, useMemo, useState } from "react";
import {
  checkoutProjectTimeline,
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
import { formatWhen, isAiBranch, isImportedGitBranch } from "./timelineLayout";
import { applyMergeTipPick, DEFAULT_PRE_MERGE_MESSAGE, mergeStartAllowed } from "./mergeCompose";
import { nextTimelineEscape } from "./timelineEscape";

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
  /** Flush the live editor before starting a merge so uncommitted CRDT edits hit disk. */
  onBeforeMerge?: (branchId?: string) => Promise<void>;
  guestBranchId?: string | null;
  leavesVersion?: number;
  onHighlightSince?: (gitHash: string) => void;
  /** Fired after a leaf is successfully opened (checkout / observe). */
  onOpenNode?: (node: TimelineNode, branch: TimelineBranch) => void;
  /** Fired as soon as the user picks a leaf, before checkout finishes — drop the previous PDF. */
  onNavigateStart?: () => void;
  /** Fired if that pick never completes, so the current leaf can show a PDF again. */
  onNavigateAbort?: () => void;
};

export function BranchTreePanel({
  projectId,
  open,
  onClose,
  onTimelineChange,
  canFork = true,
  canCheckout = true,
  canMerge = false,
  canPrune = true,
  onMergeStarted,
  onBeforeMerge,
  guestBranchId = null,
  leavesVersion = 0,
  onHighlightSince,
  onOpenNode,
  onNavigateStart,
  onNavigateAbort,
}: Props) {
  const [view, setView] = useState<TimelineView | null>(null);
  const [leafStats, setLeafStats] = useState<BranchLeafStat[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forkFrom, setForkFrom] = useState<TimelineNode | null>(null);
  const [forkName, setForkName] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [recenterToken, setRecenterToken] = useState(0);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trash, setTrash] = useState<PrunedTipInfo[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<PrunedTipInfo | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [mergeDraft, setMergeDraft] = useState<{
    filling: "from" | "into";
    fromBranchId: string | null;
    intoBranchId: string | null;
  } | null>(null);
  const [commitDirtyTarget, setCommitDirtyTarget] = useState(true);
  const [preMergeMessage, setPreMergeMessage] = useState(DEFAULT_PRE_MERGE_MESSAGE);
  const [leafMoreOpen, setLeafMoreOpen] = useState(false);

  /** Stick the hover dock so actions (Prune, etc.) remain clickable. */
  const keepDock = useCallback((id: string | null) => {
    if (id != null) setHoveredId(id);
  }, []);

  const dismissDock = useCallback(() => {
    setHoveredId(null);
  }, []);

  useEffect(() => {
    if (!open || (!hoveredId && !pinnedId) || mergeDraft) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest(".tl-hover-dock, .tl-orb, .tl-fork-modal, .tl-trash-delete-modal, .tl-trash-panel, .tl-merge-composer")) {
        return;
      }
      dismissDock();
      setPinnedId(null);
      setLeafMoreOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, hoveredId, pinnedId, mergeDraft, dismissDock]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const action = nextTimelineEscape({
        deleteOpen: Boolean(deleteTarget),
        forkOpen: Boolean(forkFrom),
        mergeDraft: Boolean(mergeDraft),
        dockOpen: Boolean(hoveredId || pinnedId),
      });
      if (action === "close-delete") {
        setDeleteTarget(null);
        setDeleteConfirm("");
        return;
      }
      if (action === "close-fork") {
        setForkFrom(null);
        return;
      }
      if (action === "cancel-merge") {
        setMergeDraft(null);
        setError(null);
        return;
      }
      if (action === "dismiss-dock") {
        dismissDock();
        setPinnedId(null);
        setLeafMoreOpen(false);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, deleteTarget, forkFrom, mergeDraft, hoveredId, pinnedId, dismissDock, onClose]);

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
  }, [open, refresh]);

  useEffect(() => {
    if (!open || !leavesVersion) return;
    void refreshLeaves();
  }, [open, leavesVersion, refreshLeaves]);

  const leafByBranch = useMemo(() => {
    const m = new Map<string, BranchLeafStat>();
    for (const s of leafStats) m.set(s.branchId, s);
    return m;
  }, [leafStats]);

  const selectNode = async (node: TimelineNode, branch: TimelineBranch) => {
    setBusy(true);
    setError(null);
    setPinnedId(node.id);
    onNavigateStart?.();
    try {
      const isTip = branch.headNodeId === node.id;
      if (guestBranchId) {
        if (!isTip) {
          setError("Share-link guests can open live tips only — ask the host to travel history");
          onNavigateAbort?.();
          return;
        }
        const next = await getProjectTimeline(projectId, branch.id);
        setView(next);
        onTimelineChange(next);
        onOpenNode?.(node, branch);
        return;
      }
      if (!canCheckout) {
        onNavigateAbort?.();
        return;
      }
      const next = await checkoutProjectTimeline(projectId, {
        branchId: branch.id,
        nodeId: isTip ? null : node.id,
      });
      setView(next);
      onTimelineChange(next);
      onOpenNode?.(node, branch);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that leaf");
      onNavigateAbort?.();
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
    const isAi = isAiBranch(branch);
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

  const beginMerge = () => {
    if (!view || !onMergeStarted) return;
    setError(null);
    setHoveredId(null);
    setPinnedId(null);
    setLeafMoreOpen(false);
    setCommitDirtyTarget(true);
    setPreMergeMessage(DEFAULT_PRE_MERGE_MESSAGE);
    setMergeDraft({
      filling: "from",
      fromBranchId: null,
      intoBranchId: view.canEdit && view.activeBranch.headNodeId ? view.activeBranchId : null,
    });
  };

  const pickMergeTip = (branch: TimelineBranch) => {
    if (!mergeDraft) return;
    if (!branch.headNodeId) {
      setError("This thread has no tip yet — commit first");
      return;
    }
    const next = applyMergeTipPick(mergeDraft, branch.id);
    if (!next.ok) {
      setError(next.error);
      return;
    }
    setError(null);
    setMergeDraft(next.draft);
  };

  const swapMergeSlots = () => {
    if (!mergeDraft?.fromBranchId || !mergeDraft.intoBranchId) return;
    setMergeDraft({
      filling: mergeDraft.filling === "from" ? "into" : "from",
      fromBranchId: mergeDraft.intoBranchId,
      intoBranchId: mergeDraft.fromBranchId,
    });
  };

  const confirmMerge = async () => {
    if (!view || !onMergeStarted || !mergeDraft?.fromBranchId || !mergeDraft.intoBranchId) return;
    const intoId = mergeDraft.intoBranchId;
    const intoDirty =
      (view.activeBranchId === intoId && !view.viewingNodeId && view.dirty) ||
      Boolean(leafByBranch.get(intoId)?.dirty);
    if (intoDirty && !commitDirtyTarget) {
      setError("Commit landing-tip edits first, or check the box to commit them automatically");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onBeforeMerge?.(intoId);
      if (view.activeBranchId !== intoId || view.viewingNodeId) {
        const next = await checkoutProjectTimeline(projectId, { branchId: intoId, nodeId: null });
        setView(next);
        onTimelineChange(next);
        await onBeforeMerge?.(intoId);
      }
      const session = await startProjectMerge(projectId, {
        sourceBranchId: mergeDraft.fromBranchId,
        targetBranchId: intoId,
        ...(commitDirtyTarget
          ? {
              commitDirtyTarget: true,
              preMergeMessage: preMergeMessage.trim() || DEFAULT_PRE_MERGE_MESSAGE,
            }
          : {}),
      });
      setMergeDraft(null);
      onMergeStarted(session);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Merge failed to start");
      try {
        const next = await getProjectTimeline(projectId, guestBranchId ?? undefined);
        setView(next);
        onTimelineChange(next);
        await refreshLeaves();
      } catch {
        /* keep the merge error */
      }
    } finally {
      setBusy(false);
    }
  };

  const onGraphClick = (node: TimelineNode, branch: TimelineBranch) => {
    if (mergeDraft) {
      if (branch.headNodeId !== node.id) {
        setError("Merges use tips — tap the pulsing end of a thread");
        return;
      }
      pickMergeTip(branch);
      return;
    }
    // Single click opens the leaf (historical checkpoint or tip). Pinning alone
    // looked like a dead graph — users expect travel on the first tap.
    setHoveredId(node.id);
    setLeafMoreOpen(false);
    void selectNode(node, branch);
  };

  if (!open) return null;

  const activeId = view?.viewingNodeId ?? view?.activeBranch.headNodeId ?? null;
  const fromBranch =
    mergeDraft?.fromBranchId && view
      ? view.branches.find((b) => b.id === mergeDraft.fromBranchId) ?? null
      : null;
  const intoBranch =
    mergeDraft?.intoBranchId && view
      ? view.branches.find((b) => b.id === mergeDraft.intoBranchId) ?? null
      : null;
  const fromHead = fromBranch?.headNodeId ?? null;
  const intoHead = intoBranch?.headNodeId ?? null;
  const intoDirty =
    Boolean(intoBranch) &&
    ((view?.activeBranchId === intoBranch?.id && !view?.viewingNodeId && Boolean(view?.dirty)) ||
      Boolean(intoBranch && leafByBranch.get(intoBranch.id)?.dirty));
  const hotId = mergeDraft ? null : hoveredId ?? pinnedId ?? activeId;
  const focusId = mergeDraft ? null : pinnedId;
  const hover = focusId && view ? view.nodes.find((n) => n.id === focusId) : null;
  const hoverBranch =
    hover && view ? view.branches.find((b) => b.id === hover.branchId) ?? null : null;
  const hoverIsHead = Boolean(hoverBranch && hover && hoverBranch.headNodeId === hover.id);
  const hoverIsSacred = Boolean(hoverBranch?.sacred);
  const hoverIsAi = isAiBranch(hoverBranch);
  const hoverIsImportedGit = isImportedGitBranch(hoverBranch);
  const showTrash = canPrune && !guestBranchId;
  const gitExploreBranches = view
    ? [
        view.branches.find((b) => b.id === "main"),
        ...view.branches.filter((b) => isImportedGitBranch(b) && b.id !== "main"),
      ].filter((b): b is TimelineBranch => Boolean(b))
    : [];
  const exploreValue = gitExploreBranches.some((b) => b.id === view?.activeBranchId)
    ? view!.activeBranchId
    : "main";

  const exploreGitBranch = async (branchId: string) => {
    if (!view) return;
    const branch = view.branches.find((b) => b.id === branchId);
    if (!branch?.headNodeId) return;
    const node = view.nodes.find((n) => n.id === branch.headNodeId);
    if (!node) return;
    await selectNode(node, branch);
    setRecenterToken((n) => n + 1);
  };

  return (
    <aside className="history-drawer timeline-drawer" aria-label="Branch timeline">
      <div className="history-drawer-head">
        <strong>
          Sacred timeline
          {view ? ` · ${view.nodes.length} leaf${view.nodes.length === 1 ? "" : "ves"}` : ""}
        </strong>
        <div className="history-drawer-actions">
          {canMerge && !guestBranchId && onMergeStarted && !mergeDraft && (
            <button
              type="button"
              className="btn btn-quiet tl-merge-btn"
              disabled={busy || loading || !view}
              onClick={() => beginMerge()}
              title="Bring one tip into another — tap two tips on the graph"
            >
              Merge
            </button>
          )}
          {mergeDraft && (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                setMergeDraft(null);
                setError(null);
              }}
            >
              Cancel
            </button>
          )}
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
        {mergeDraft
          ? mergeDraft.filling === "from"
            ? "Tap the tip to bring in. The blinking line is a preview of the merge."
            : mergeDraft.fromBranchId
              ? "Tap the tip that should receive it — or Start merge if both sides are set."
              : "Tap the tip that should receive the incoming work."
          : "Time runs left → right. Tap a leaf to inspect. Git branches besides main appear as extra threads."}
      </p>

      {gitExploreBranches.length > 1 && !mergeDraft && (
        <label className="tl-git-explore">
          <span className="tl-git-explore-label">Explore git branch</span>
          <select
            value={exploreValue}
            disabled={busy || loading}
            aria-label="Explore a git branch on the timeline"
            onChange={(e) => void exploreGitBranch(e.target.value)}
          >
            {gitExploreBranches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {view?.gitHeadBranch && (view.gitHeadBranch === b.gitRef || view.gitHeadBranch === b.name)
                  ? " · checked out"
                  : ""}
              </option>
            ))}
          </select>
        </label>
      )}

      {error && <div className="error-banner">{error}</div>}

      {mergeDraft && view && (
        <div className="tl-merge-composer" role="region" aria-label="Compose merge">
          <div className="tl-merge-slots">
            <button
              type="button"
              className={`tl-merge-slot is-from${mergeDraft.filling === "from" ? " is-filling" : ""}${fromBranch ? " is-set" : ""}`}
              onClick={() => setMergeDraft({ ...mergeDraft, filling: "from" })}
            >
              <span className="tl-merge-slot-kicker">From</span>
              <span className="tl-merge-slot-value">{fromBranch ? fromBranch.name : "Tap a tip"}</span>
            </button>
            <button
              type="button"
              className="tl-merge-swap"
              onClick={() => swapMergeSlots()}
              disabled={!fromBranch || !intoBranch}
              title="Swap from and into"
              aria-label="Swap from and into"
            >
              →
            </button>
            <button
              type="button"
              className={`tl-merge-slot is-into${mergeDraft.filling === "into" ? " is-filling" : ""}${intoBranch ? " is-set" : ""}`}
              onClick={() => setMergeDraft({ ...mergeDraft, filling: "into" })}
            >
              <span className="tl-merge-slot-kicker">Into</span>
              <span className="tl-merge-slot-value">{intoBranch ? intoBranch.name : "Tap a tip"}</span>
            </button>
          </div>
          {fromBranch && intoBranch && (
            <p className="tl-merge-preview-copy">
              After merge, <code>{intoBranch.name}</code> grows a new leaf, with a dotted line from{" "}
              <code>{fromBranch.name}</code> — blinking on the graph until you start.
            </p>
          )}
          <ul className="tl-merge-checklist">
            <li className={fromBranch && intoBranch && fromBranch.id !== intoBranch.id ? "is-ok" : "is-bad"}>
              {fromBranch && intoBranch && fromBranch.id !== intoBranch.id
                ? `Bring ${fromBranch.name} into ${intoBranch.name}`
                : "Pick two different tips"}
            </li>
            <li className={intoBranch && (!intoDirty || commitDirtyTarget) ? "is-ok" : "is-bad"}>
              {intoBranch && commitDirtyTarget
                ? intoDirty
                  ? "Landing-tip edits will be committed first"
                  : "Uncommitted landing-tip edits will be committed first if any"
                : intoBranch && !intoDirty
                  ? "Landing tip is clean"
                  : intoBranch
                    ? "Landing tip has uncommitted edits — check the box below, or commit first"
                    : "Landing tip not chosen yet"}
            </li>
          </ul>
          {intoBranch && (
            <div className="tl-merge-precommit">
              <label className="share-check">
                <input
                  type="checkbox"
                  checked={commitDirtyTarget}
                  onChange={(e) => setCommitDirtyTarget(e.target.checked)}
                />
                <span>
                  <strong>Commit uncommitted edits, then merge</strong>
                  <span className="share-muted"> — snapshot the landing tip so you don’t have to leave and click Commit first</span>
                </span>
              </label>
              {commitDirtyTarget && (
                <label className="tl-merge-precommit-msg">
                  Commit message
                  <input
                    type="text"
                    value={preMergeMessage}
                    onChange={(e) => setPreMergeMessage(e.target.value)}
                    placeholder={DEFAULT_PRE_MERGE_MESSAGE}
                    maxLength={200}
                  />
                </label>
              )}
            </div>
          )}
          <div className="history-drawer-actions tl-merge-composer-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                setMergeDraft(null);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                busy ||
                !mergeStartAllowed({
                  fromSet: Boolean(fromBranch),
                  intoSet: Boolean(intoBranch),
                  distinct: Boolean(fromBranch && intoBranch && fromBranch.id !== intoBranch.id),
                  intoDirty,
                  commitDirtyTarget,
                })
              }
              onClick={() => void confirmMerge()}
            >
              {busy
                ? commitDirtyTarget
                  ? "Committing…"
                  : "Starting…"
                : commitDirtyTarget
                  ? "Commit & start merge"
                  : "Start merge"}
            </button>
          </div>
        </div>
      )}

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

      <TimelineGraph
        view={view}
        loading={loading}
        selectedId={activeId}
        hotId={hotId}
        leafByBranch={leafByBranch}
        recenterToken={recenterToken}
        busy={busy}
        emptyLabel="No leaves yet — commit on a tip to begin."
        onHoverIdChange={mergeDraft ? undefined : keepDock}
        onNodeClick={(node, branch) => onGraphClick(node, branch)}
        merging={Boolean(mergeDraft)}
        mergeFromId={fromHead}
        mergeIntoId={intoHead}
      >
        {hover && hoverBranch && (
          <div
            className={`tl-hover-dock${hoverIsSacred ? " is-sacred" : ""}${hoverIsAi ? " is-ai" : ""}`}
          >
            <div className="tl-hover-dock-main">
              <div className="tl-card-title">{hover.message || "Untitled leaf"}</div>
              <div className="tl-card-meta">
                <span className="tl-card-branch">{hoverBranch.name}</span>
                {hoverIsHead && <span>tip</span>}
                {hoverIsAi && <span className="tl-ai-tag">AI</span>}
                {hoverIsImportedGit && <span className="tl-chip">git</span>}
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
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void selectNode(hover, hoverBranch)}
                >
                  {hover.id === activeId ? "Here" : "Open"}
                </button>
              )}
              {guestBranchId && hoverIsHead && (
                <button
                  type="button"
                  className="btn btn-primary"
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
              {(onHighlightSince ||
                (canPrune &&
                  !guestBranchId &&
                  hoverIsHead &&
                  !hoverIsSacred &&
                  hoverBranch.id !== "main")) && (
                <button
                  type="button"
                  className={`btn btn-ghost${leafMoreOpen ? " is-active" : ""}`}
                  onClick={() => setLeafMoreOpen((v) => !v)}
                  aria-expanded={leafMoreOpen}
                >
                  More
                </button>
              )}
              {leafMoreOpen && onHighlightSince && (
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
              {leafMoreOpen &&
                canPrune &&
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
            </div>
          </div>
        )}
      </TimelineGraph>

      {forkFrom && (
        <div className="tl-fork-modal timeline-fork-modal" role="dialog" aria-modal="true" aria-label="Fork a new thread">
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
    </aside>
  );
}
