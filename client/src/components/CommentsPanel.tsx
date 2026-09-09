import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createProjectComment,
  deleteProjectComment,
  listProjectComments,
  patchProjectComment,
  replyProjectComment,
} from "../api/client";
import type { CommentAnchor, CommentThread } from "../api/types";

export type CommentDraft = {
  anchor: CommentAnchor;
  /** Prefill shown in the compose box */
  hint?: string;
};

type Props = {
  projectId: string;
  identityId?: string;
  open: boolean;
  onClose: () => void;
  /** Live refresh signal from collab meta.commentsVersion */
  commentsVersion?: number;
  draft?: CommentDraft | null;
  onDraftConsumed?: () => void;
  onJump: (anchor: CommentAnchor) => void;
  onThreadsChange?: (threads: CommentThread[]) => void;
};

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function anchorLabel(a: CommentAnchor): string {
  const base = `${a.file}:${a.line}`;
  if (a.pdfPage) return `${base} · PDF p.${a.pdfPage}`;
  return base;
}

export function CommentsPanel({
  projectId,
  identityId,
  open,
  onClose,
  commentsVersion = 0,
  draft,
  onDraftConsumed,
  onJump,
  onThreadsChange,
}: Props) {
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [composeBody, setComposeBody] = useState("");
  const [composeAnchor, setComposeAnchor] = useState<CommentAnchor | null>(null);
  const [busy, setBusy] = useState(false);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listProjectComments(projectId);
      setThreads(list);
      onThreadsChange?.(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load comments");
    } finally {
      setLoading(false);
    }
  }, [projectId, onThreadsChange]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh, commentsVersion]);

  useEffect(() => {
    if (!draft) return;
    setComposeAnchor(draft.anchor);
    setComposeBody("");
    setSelectedId(null);
  }, [draft]);

  const visible = useMemo(() => {
    const list = filter === "open" ? threads.filter((t) => !t.resolved) : threads;
    return [...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }, [threads, filter]);

  const openCount = threads.filter((t) => !t.resolved).length;

  const submitCompose = async () => {
    if (!identityId || !composeAnchor || !composeBody.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { thread } = await createProjectComment(projectId, {
        identityId,
        body: composeBody.trim(),
        anchor: composeAnchor,
      });
      setComposeBody("");
      setComposeAnchor(null);
      onDraftConsumed?.();
      await refresh();
      setSelectedId(thread.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to post comment");
    } finally {
      setBusy(false);
    }
  };

  const onReply = async (commentId: string) => {
    if (!identityId) return;
    const body = (replyDrafts[commentId] ?? "").trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      await replyProjectComment(projectId, commentId, { identityId, body });
      setReplyDrafts((m) => ({ ...m, [commentId]: "" }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reply");
    } finally {
      setBusy(false);
    }
  };

  const onToggleResolved = async (thread: CommentThread) => {
    setBusy(true);
    setError(null);
    try {
      await patchProjectComment(projectId, thread.id, {
        identityId,
        resolved: !thread.resolved,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (thread: CommentThread) => {
    if (!window.confirm("Delete this comment thread?")) return;
    setBusy(true);
    setError(null);
    try {
      await deleteProjectComment(projectId, thread.id, identityId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="comments-drawer" role="dialog" aria-label="Comments">
      <div className="history-drawer-head">
        <strong>Comments{openCount ? ` (${openCount})` : ""}</strong>
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
        <strong>How to add one:</strong> select text in Source → <kbd>⌘⌥M</kbd> / <kbd>Ctrl+Alt+M</kbd> (or the
        Comment button), or <strong>Shift+click</strong> the PDF. Threads are saved in <code>comments.json</code>.
      </p>

      <div className="comments-filter">
        <button
          type="button"
          className={`btn btn-ghost${filter === "open" ? " comments-filter-active" : ""}`}
          onClick={() => setFilter("open")}
        >
          Open
        </button>
        <button
          type="button"
          className={`btn btn-ghost${filter === "all" ? " comments-filter-active" : ""}`}
          onClick={() => setFilter("all")}
        >
          All
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {composeAnchor && (
        <div className="comments-compose">
          <div className="comments-compose-meta">
            New comment · <button type="button" className="linkish" onClick={() => onJump(composeAnchor)}>
              {anchorLabel(composeAnchor)}
            </button>
            {draft?.hint ? <span className="comments-quote">“{draft.hint}”</span> : null}
          </div>
          {!identityId && <div className="empty-hint">Pick an identity in the toolbar first.</div>}
          <textarea
            className="comments-textarea"
            rows={3}
            placeholder="Write a comment…"
            value={composeBody}
            onChange={(e) => setComposeBody(e.target.value)}
            disabled={!identityId || busy}
          />
          <div className="comments-compose-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setComposeAnchor(null);
                setComposeBody("");
                onDraftConsumed?.();
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!identityId || busy || !composeBody.trim()}
              onClick={() => void submitCompose()}
            >
              Post
            </button>
          </div>
        </div>
      )}

      {loading && threads.length === 0 ? (
        <div className="empty-hint">Loading…</div>
      ) : visible.length === 0 ? (
        <div className="empty-hint empty-hint-card comments-empty">
          <strong>{filter === "open" ? "No open comments" : "No comments yet"}</strong>
          <p>
            {filter === "open"
              ? "Resolved threads are under All. Start one by selecting source text or Shift+clicking the PDF."
              : "Select text in Source → ⌘⌥M / Ctrl+Alt+M, or Shift+click the PDF to leave a note."}
          </p>
        </div>
      ) : (
        <ul className="comments-list">
          {visible.map((t) => (
            <li
              key={t.id}
              className={`comments-item${t.resolved ? " resolved" : ""}${selectedId === t.id ? " selected" : ""}`}
            >
              <button type="button" className="comments-item-jump" onClick={() => { setSelectedId(t.id); onJump(t.anchor); }}>
                <span className="comments-avatar" style={{ background: t.authorColor }} title={t.authorName} />
                <span className="comments-item-main">
                  <span className="comments-author">{t.authorName}</span>
                  <span className="comments-loc">{anchorLabel(t.anchor)}</span>
                  <span className="comments-body">{t.body}</span>
                  {t.anchor.quote ? <span className="comments-quote">“{t.anchor.quote}”</span> : null}
                  <span className="comments-meta">
                    {formatWhen(t.createdAt)}
                    {t.replies.length ? ` · ${t.replies.length} repl${t.replies.length === 1 ? "y" : "ies"}` : ""}
                    {t.resolved ? " · resolved" : ""}
                  </span>
                </span>
              </button>

              {t.replies.length > 0 && (
                <ul className="comments-replies">
                  {t.replies.map((r) => (
                    <li key={r.id} className="comments-reply">
                      <span className="comments-avatar sm" style={{ background: r.authorColor }} />
                      <div>
                        <strong>{r.authorName}</strong>
                        <span className="comments-meta"> · {formatWhen(r.createdAt)}</span>
                        <div className="comments-body">{r.body}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="comments-item-actions">
                <input
                  className="comments-reply-input"
                  placeholder="Reply…"
                  value={replyDrafts[t.id] ?? ""}
                  disabled={!identityId || busy}
                  onChange={(e) => setReplyDrafts((m) => ({ ...m, [t.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void onReply(t.id);
                    }
                  }}
                />
                <button type="button" className="btn btn-ghost" disabled={!identityId || busy} onClick={() => void onReply(t.id)}>
                  Reply
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void onToggleResolved(t)}>
                  {t.resolved ? "Reopen" : "Resolve"}
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void onDelete(t)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
