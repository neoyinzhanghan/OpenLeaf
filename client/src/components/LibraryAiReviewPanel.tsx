import { useCallback, useEffect, useState } from "react";
import {
  acceptLibraryAiProposal,
  listLibraryAiReview,
  rejectLibraryAiProposal,
  type LibraryAiProposal,
} from "../api/libraryAi";

type Props = {
  open: boolean;
  onClose: () => void;
  onAccepted?: () => void;
  onCountChange?: (count: number) => void;
};

function authorsLabel(authors: LibraryAiProposal["authors"]): string {
  if (!authors.length) return "Unknown authors";
  return authors
    .slice(0, 4)
    .map((a) => (a.given ? `${a.family}, ${a.given}` : a.family))
    .join("; ");
}

export function LibraryAiReviewPanel({ open, onClose, onAccepted, onCountChange }: Props) {
  const [proposals, setProposals] = useState<LibraryAiProposal[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listLibraryAiReview();
      setProposals(data.proposals);
      onCountChange?.(data.count);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const t = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(t);
  }, [open, refresh]);

  if (!open) return null;

  const onAccept = async (proposalId: string) => {
    setBusy(proposalId);
    setError(null);
    try {
      await acceptLibraryAiProposal({ proposalId });
      await refresh();
      onAccepted?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onReject = async (proposalId: string) => {
    setBusy(proposalId);
    setError(null);
    try {
      await rejectLibraryAiProposal({ proposalId });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onAcceptAll = async () => {
    setBusy("all");
    setError(null);
    try {
      await acceptLibraryAiProposal({ all: true });
      await refresh();
      onAccepted?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onRejectAll = async () => {
    if (!confirm(`Reject all ${proposals.length} pending AI paper proposals?`)) return;
    setBusy("all");
    setError(null);
    try {
      await rejectLibraryAiProposal({ all: true });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="share-drawer library-share-drawer" role="dialog" aria-label="Review AI library additions">
      <div className="share-body">
        <div className="share-cred" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <div>
            <p className="share-section-title" style={{ margin: 0 }}>
              Review AI additions
            </p>
            <p className="share-muted" style={{ margin: "4px 0 0" }}>
              Verified proposals waiting for Accept — same idea as AI edit review
            </p>
          </div>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {error ? <div className="share-error">{error}</div> : null}

        {proposals.length > 0 ? (
          <div className="library-ai-review-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={Boolean(busy)}
              onClick={() => void onAcceptAll()}
            >
              Accept all
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={Boolean(busy)}
              onClick={() => void onRejectAll()}
            >
              Reject all
            </button>
          </div>
        ) : null}

        {loading && !proposals.length ? <p className="muted">Loading…</p> : null}
        {!loading && !proposals.length ? (
          <p className="muted">No pending AI paper proposals.</p>
        ) : null}

        <ul className="library-ai-review-list">
          {proposals.map((p) => (
            <li key={p.id} className="library-ai-review-card">
              <div className="library-ai-review-card-head">
                <strong>{p.title}</strong>
                <span className="lib-badge">{p.identifier}</span>
              </div>
              <p className="muted">{authorsLabel(p.authors)}</p>
              <p className="muted">
                {p.venue || "—"}
                {p.year != null ? ` · ${p.year}` : ""}
                {p.doi ? ` · ${p.doi}` : ""}
                {p.arxivId ? ` · arXiv:${p.arxivId}` : ""}
              </p>
              <p className="muted library-hint">
                From “{p.sessionTitle}” · {new Date(p.proposedAt).toLocaleString()}
              </p>
              {p.abstract ? <p className="library-abstract">{p.abstract.slice(0, 280)}{p.abstract.length > 280 ? "…" : ""}</p> : null}
              <div className="library-ai-review-card-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={Boolean(busy)}
                  onClick={() => void onAccept(p.id)}
                >
                  {busy === p.id ? "…" : "Accept"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={Boolean(busy)}
                  onClick={() => void onReject(p.id)}
                >
                  Reject
                </button>
                {p.url ? (
                  <a className="btn btn-quiet" href={p.url} target="_blank" rel="noreferrer">
                    Open source
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
