import { useCallback, useEffect, useRef, useState } from "react";
import { checkoutProjectTimeline } from "../api/client";
import type { TimelineView } from "../api/types";
import {
  acceptAiReview,
  listProjectAiReview,
  rejectAiReview,
  type AiReviewCollaborator,
  type AiReviewHunk,
} from "../api/share";
import { AiSuggestionCard } from "./AiSuggestionCard";
import { ErrorBanner } from "./ErrorBanner";

type Props = {
  projectId: string;
  open: boolean;
  onClose: () => void;
  currentBranchId?: string;
  reviewVersion?: number;
  activeHunkId?: string | null;
  onActiveHunkIdChange?: (id: string | null) => void;
  onCollaboratorsChange?: (collaborators: AiReviewCollaborator[]) => void;
  onCountChange?: (hunkCount: number) => void;
  onTimelineChange?: (view: TimelineView) => void;
  onJump?: (path: string, line: number, column?: number) => void;
  /** Called after a hunk is opened in the editor (mobile closes the list sheet). */
  onPickedHunk?: () => void;
  variant?: "drawer" | "sheet";
  /** Re-open this sandbox's first pending suggestion when the nonce changes. */
  focusBranchId?: string | null;
  focusNonce?: number;
};

function firstHunk(c: AiReviewCollaborator): AiReviewHunk | undefined {
  for (const file of c.files) {
    if (file.hunks[0]) return file.hunks[0];
  }
  return undefined;
}

export function AiReviewPanel({
  projectId,
  open,
  onClose,
  currentBranchId,
  reviewVersion = 0,
  activeHunkId = null,
  onActiveHunkIdChange,
  onCollaboratorsChange,
  onCountChange,
  onTimelineChange,
  onJump,
  onPickedHunk,
  variant = "drawer",
  focusBranchId = null,
  focusNonce = 0,
}: Props) {
  const [collaborators, setCollaborators] = useState<AiReviewCollaborator[]>([]);
  const [hunkCount, setHunkCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const consumedFocusNonce = useRef(0);

  const applyList = useCallback(
    (data: { collaborators: AiReviewCollaborator[]; hunkCount: number }) => {
      setCollaborators(data.collaborators);
      setHunkCount(data.hunkCount);
      onCountChange?.(data.hunkCount);
      onCollaboratorsChange?.(data.collaborators);
    },
    [onCountChange, onCollaboratorsChange],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      applyList(await listProjectAiReview(projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load AI review");
    } finally {
      setLoading(false);
    }
  }, [projectId, applyList]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh, reviewVersion]);

  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(t);
  }, [open, refresh]);

  useEffect(() => {
    if (!activeHunkId) return;
    const el = document.querySelector(`[data-hunk-id="${CSS.escape(activeHunkId)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeHunkId]);

  const openSuggestion = useCallback(
    async (c: AiReviewCollaborator, hunk?: AiReviewHunk) => {
      try {
        if (currentBranchId !== c.branchId) {
          const view = await checkoutProjectTimeline(projectId, { branchId: c.branchId, nodeId: null });
          onTimelineChange?.(view);
        }
        if (hunk) {
          onActiveHunkIdChange?.(hunk.id);
          const range = hunk.ranges?.[0];
          onJump?.(hunk.path, range?.startLine ?? Math.max(1, hunk.newStart), range?.startColumn ?? 1);
          onPickedHunk?.();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not open AI sandbox");
      }
    },
    [currentBranchId, projectId, onTimelineChange, onActiveHunkIdChange, onJump, onPickedHunk],
  );

  useEffect(() => {
    if (!open || !focusNonce || !focusBranchId) return;
    if (focusNonce === consumedFocusNonce.current) return;
    if (loading) return;
    const c = collaborators.find((x) => x.branchId === focusBranchId);
    if (!c) return;
    const timer = window.setTimeout(() => {
      if (consumedFocusNonce.current === focusNonce) return;
      consumedFocusNonce.current = focusNonce;
      void openSuggestion(c, firstHunk(c));
    }, 50);
    return () => window.clearTimeout(timer);
  }, [open, focusNonce, focusBranchId, loading, collaborators, openSuggestion]);

  const run = async (
    aiId: string,
    action: "accept" | "reject",
    body: { hunkId?: string; path?: string; all?: boolean },
  ) => {
    setBusy(`${action}:${body.hunkId ?? body.path ?? "all"}`);
    setError(null);
    try {
      const next =
        action === "accept"
          ? await acceptAiReview(projectId, aiId, body)
          : await rejectAiReview(projectId, aiId, body);
      const data = await listProjectAiReview(projectId);
      applyList({
        collaborators: data.collaborators.map((c) => (c.aiId === aiId ? next : c)),
        hunkCount: data.hunkCount,
      });
      if (body.hunkId && body.hunkId === activeHunkId) onActiveHunkIdChange?.(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Review action failed");
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  if (!open) return null;

  return (
    <div className={`comments-drawer ai-review-drawer${variant === "sheet" ? " is-sheet" : ""}`} role="dialog" aria-label="AI suggestions">
      <div className="history-drawer-head">
        <strong>AI suggestions{hunkCount ? ` (${hunkCount})` : ""}</strong>
        <div className="history-drawer-actions">
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

      <p className="history-hint">
        Click a suggestion to see it in the manuscript. <strong>Accept</strong> keeps the AI wording;{" "}
        <strong>Dismiss</strong> restores what was there.
      </p>

      {error ? <ErrorBanner className="error-banner" onDismiss={() => setError(null)}>{error}</ErrorBanner> : null}

      {loading && collaborators.length === 0 ? (
        <div className="empty-hint">Loading…</div>
      ) : collaborators.length === 0 ? (
        <div className="empty-hint empty-hint-card comments-empty">
          <strong>No live AI sandbox</strong>
          <p>Mint an AI collaborator from <strong>AI links</strong>. Phrase-level suggestions show up here as you edit.</p>
        </div>
      ) : (
        <div className="ai-review-list">
          {collaborators.map((c) => (
            <section key={c.aiId} className="ai-review-collab">
              <div className="ai-review-collab-head">
                <span className="tl-chip ai">AI</span>
                <code title={c.branchName}>{c.slug}</code>
                <button type="button" className="btn btn-ghost share-copy" onClick={() => void openSuggestion(c)}>
                  Open in editor
                </button>
                {c.hunkCount > 0 && (
                  <>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={Boolean(busy)}
                      onClick={() => void run(c.aiId, "accept", { all: true })}
                    >
                      Accept all
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={Boolean(busy)}
                      onClick={() => void run(c.aiId, "reject", { all: true })}
                    >
                      Dismiss all
                    </button>
                  </>
                )}
              </div>
              {c.hunkCount === 0 ? (
                <p className="share-muted share-pad">No pending suggestions.</p>
              ) : (
                c.files.map((file) => (
                  <div key={file.path} className="ai-review-file">
                    <div className="ai-review-file-head">
                      <strong>{file.path}</strong>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={Boolean(busy)}
                        onClick={() => void run(c.aiId, "accept", { path: file.path })}
                      >
                        Accept file
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={Boolean(busy)}
                        onClick={() => void run(c.aiId, "reject", { path: file.path })}
                      >
                        Dismiss file
                      </button>
                    </div>
                    {file.hunks.length === 0 ? (
                      <p className="share-muted share-pad">Whitespace-only change — use Accept file or Dismiss file.</p>
                    ) : (
                      file.hunks.map((hunk) => (
                        <AiSuggestionCard
                          key={hunk.id}
                          hunk={hunk}
                          selected={activeHunkId === hunk.id}
                          busy={Boolean(busy)}
                          onSelect={() => void openSuggestion(c, hunk)}
                          onAccept={() => void run(c.aiId, "accept", { hunkId: hunk.id })}
                          onReject={() => void run(c.aiId, "reject", { hunkId: hunk.id })}
                        />
                      ))
                    )}
                  </div>
                ))
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
