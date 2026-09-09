import { useCallback, useEffect, useState } from "react";
import { listProjectHistory, restoreProjectHistory } from "../api/client";
import type { GitCommitInfo } from "../api/types";

type Props = {
  projectId: string;
  identityId?: string;
  open: boolean;
  onClose: () => void;
  onRestored: () => void;
  /** Guests may browse but never restore. */
  canRestore?: boolean;
  onHighlightSince?: (commit: GitCommitInfo) => void;
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

export function HistoryPanel({
  projectId,
  identityId,
  open,
  onClose,
  onRestored,
  canRestore = true,
  onHighlightSince,
}: Props) {
  const [commits, setCommits] = useState<GitCommitInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyHash, setBusyHash] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCommits(await listProjectHistory(projectId, 80));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load history");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const onRestore = async (hash: string) => {
    if (!window.confirm(`Restore project files from ${hash.slice(0, 7)}? Current edits will be saved first.`)) {
      return;
    }
    setBusyHash(hash);
    setError(null);
    try {
      await restoreProjectHistory(projectId, hash, identityId);
      await refresh();
      onRestored();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore failed");
    } finally {
      setBusyHash(null);
    }
  };

  if (!open) return null;

  return (
    <div className="history-drawer" role="dialog" aria-label="Version history">
      <div className="history-drawer-head">
        <strong>Version history</strong>
        <div className="history-drawer-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void refresh()} disabled={loading}>
            Refresh
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <p className="history-hint">
        Automatic git snapshots on each save.{" "}
        {canRestore
          ? "Restore copies that revision into the working tree."
          : "Only the host can restore a snapshot."}{" "}
        Highlight additions maps new .tex lines since a snapshot onto the PDF (preview overlay).
      </p>
      {error && <div className="error-banner">{error}</div>}
      {loading && commits.length === 0 ? (
        <div className="empty-hint">Loading…</div>
      ) : commits.length === 0 ? (
        <div className="empty-hint">No snapshots yet — save the project to create one.</div>
      ) : (
        <ul className="history-list">
          {commits.map((c) => (
            <li key={c.hash} className="history-item">
              <div className="history-item-main">
                <code className="history-hash">{c.shortHash}</code>
                <span className="history-msg">{c.message}</span>
                <span className="history-meta">
                  {c.author} · {formatWhen(c.date)}
                </span>
              </div>
              <div className="history-item-actions">
                {onHighlightSince && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      onHighlightSince(c);
                      onClose();
                    }}
                    title="Highlight manuscript lines added after this snapshot"
                  >
                    Highlight since
                  </button>
                )}
                {canRestore && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busyHash === c.hash}
                    onClick={() => void onRestore(c.hash)}
                  >
                    {busyHash === c.hash ? "Restoring…" : "Restore"}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
