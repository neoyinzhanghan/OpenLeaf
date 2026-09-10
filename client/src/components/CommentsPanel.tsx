import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createProjectComment,
  deleteProjectComment,
  listProjectComments,
  patchProjectComment,
  replyProjectComment,
} from "../api/client";
import type { CommentAnchor, CommentReply, CommentThread } from "../api/types";

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
  /** Open / highlight a thread (e.g. from editor gutter click). */
  focusThreadId?: string | null;
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

function isPdfAnchor(a: CommentAnchor): boolean {
  return a.pdfPage != null && a.pdfPage > 0;
}

function surfaceLabel(a: CommentAnchor): string {
  if (isPdfAnchor(a)) return `PDF · p.${a.pdfPage}`;
  return "Source";
}

function anchorLabel(a: CommentAnchor): string {
  const base = `${a.file}:${a.line}`;
  if (isPdfAnchor(a)) return `${base} · PDF p.${a.pdfPage}`;
  return base;
}

function AuthorRow({
  name,
  color,
  when,
  badge,
}: {
  name: string;
  color: string;
  when: string;
  badge?: string;
}) {
  return (
    <div className="comments-author-row">
      <span className="comments-avatar" style={{ background: color }} title={name} />
      <div className="comments-author-meta">
        <span className="comments-author">
          {name}
          {badge ? <span className="comments-author-badge">{badge}</span> : null}
        </span>
        <span className="comments-meta">{formatWhen(when)}</span>
      </div>
    </div>
  );
}

function MessageBody({ body, quote }: { body: string; quote?: string }) {
  return (
    <>
      <div className="comments-body">{body}</div>
      {quote ? <div className="comments-quote">“{quote}”</div> : null}
    </>
  );
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
  focusThreadId = null,
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

  useEffect(() => {
    if (!focusThreadId) return;
    setSelectedId(focusThreadId);
    setFilter("all");
  }, [focusThreadId]);

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
      setSelectedId(commentId);
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
      if (selectedId === thread.id) setSelectedId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setBusy(false);
    }
  };

  const selectThread = (thread: CommentThread) => {
    setSelectedId(thread.id);
    onJump(thread.anchor);
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
        Threaded notes on <strong>source</strong> or the <strong>PDF</strong>. Select text in the editor →{" "}
        <kbd>⌘⌥M</kbd> / <kbd>Ctrl+Alt+M</kbd>, or <strong>Shift+click</strong> the PDF. Replies stay with the
        author who wrote them (including AI).
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
            <span className={`comments-surface${isPdfAnchor(composeAnchor) ? " is-pdf" : " is-source"}`}>
              {surfaceLabel(composeAnchor)}
            </span>
            <button type="button" className="linkish" onClick={() => onJump(composeAnchor)}>
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
            autoFocus
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
              Comment
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
            Start a thread from the editor selection or Shift+click the PDF. Everyone — including the AI helper —
            shows up with their name on each message.
          </p>
        </div>
      ) : (
        <ul className="comments-list">
          {visible.map((t) => {
            const selected = selectedId === t.id;
            const aiRoot = t.authorId.startsWith("ai-") || t.authorName.startsWith("AI ·");
            return (
              <li
                key={t.id}
                className={`comments-item${t.resolved ? " resolved" : ""}${selected ? " selected" : ""}`}
              >
                <button type="button" className="comments-item-jump" onClick={() => selectThread(t)}>
                  <div className="comments-thread-head">
                    <span className={`comments-surface${isPdfAnchor(t.anchor) ? " is-pdf" : " is-source"}`}>
                      {surfaceLabel(t.anchor)}
                    </span>
                    <span className="comments-loc">{anchorLabel(t.anchor)}</span>
                    {t.resolved ? <span className="comments-resolved-pill">Resolved</span> : null}
                  </div>
                  <AuthorRow
                    name={t.authorName}
                    color={t.authorColor}
                    when={t.createdAt}
                    badge={aiRoot ? "AI" : undefined}
                  />
                  <MessageBody body={t.body} quote={t.anchor.quote} />
                  {!selected && t.replies.length > 0 ? (
                    <span className="comments-meta comments-thread-preview">
                      {t.replies.length} repl{t.replies.length === 1 ? "y" : "ies"} · click to open thread
                    </span>
                  ) : null}
                </button>

                {selected && (
                  <div className="comments-thread">
                    {t.replies.length > 0 && (
                      <ul className="comments-replies">
                        {t.replies.map((r: CommentReply) => {
                          const aiReply = r.authorId.startsWith("ai-") || r.authorName.startsWith("AI ·");
                          return (
                            <li key={r.id} className="comments-reply">
                              <AuthorRow
                                name={r.authorName}
                                color={r.authorColor}
                                when={r.createdAt}
                                badge={aiReply ? "AI" : undefined}
                              />
                              <MessageBody body={r.body} />
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    <div className="comments-reply-box">
                      {!identityId ? (
                        <div className="empty-hint">Pick an identity to reply.</div>
                      ) : (
                        <>
                          <textarea
                            className="comments-textarea"
                            rows={2}
                            placeholder="Reply to this thread…"
                            value={replyDrafts[t.id] ?? ""}
                            disabled={busy}
                            onChange={(e) => setReplyDrafts((m) => ({ ...m, [t.id]: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                e.preventDefault();
                                void onReply(t.id);
                              }
                            }}
                          />
                          <div className="comments-item-actions">
                            <button
                              type="button"
                              className="btn btn-primary"
                              disabled={busy || !(replyDrafts[t.id] ?? "").trim()}
                              onClick={() => void onReply(t.id)}
                            >
                              Reply
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              disabled={busy}
                              onClick={() => void onToggleResolved(t)}
                            >
                              {t.resolved ? "Reopen" : "Resolve"}
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              disabled={busy}
                              onClick={() => void onDelete(t)}
                            >
                              Delete
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {!selected && (
                  <div className="comments-item-actions comments-item-actions-collapsed">
                    <button type="button" className="btn btn-ghost" onClick={() => selectThread(t)}>
                      Open thread
                    </button>
                    <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void onToggleResolved(t)}>
                      {t.resolved ? "Reopen" : "Resolve"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
