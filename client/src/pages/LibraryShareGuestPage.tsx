import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchLibraryShareBundle,
  getLibraryShareGuest,
  importLibraryShare,
  joinLibraryShare,
  librarySharePdfUrl,
  postLibraryShareNote,
  type LibraryShareGuestView,
  type SharedPaperView,
} from "../api/libraryShare";
import { ThemePicker } from "../components/ThemeToggle";
import { useSession } from "../session/SessionContext";

const VISITOR_KEY = (token: string) => `openleaf-lib-share-visitor:${token}`;

function authorsLabel(paper: SharedPaperView): string {
  if (!paper.authors.length) return "Unknown authors";
  return paper.authors
    .map((a) => (a.given ? `${a.family}, ${a.given}` : a.family))
    .join("; ");
}

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function LibraryShareGuestPage() {
  const { token = "" } = useParams<{ token: string }>();
  const { session } = useSession();
  const hostSignedIn = session.kind === "host";

  const [share, setShare] = useState<LibraryShareGuestView | null>(null);
  const [visitorId, setVisitorId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [joined, setJoined] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const stored = localStorage.getItem(VISITOR_KEY(token)) ?? undefined;
      const { share: view } = await getLibraryShareGuest(token, stored);
      setShare(view);
      setGone(false);
      if (view.visitor) {
        setVisitorId(view.visitor.id);
        setName(view.visitor.name);
        setJoined(true);
      }
      if (!selectedKey && view.papers[0]) setSelectedKey(view.papers[0].citekey);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not found|expired/i.test(msg)) setGone(true);
      setError(msg);
    }
  }, [token, selectedKey]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll refresh; avoid reset on selectedKey
  }, [token]);

  const selected = useMemo(
    () => share?.papers.find((p) => p.citekey === selectedKey) ?? null,
    [share, selectedKey],
  );

  const paperNotes = useMemo(
    () => (share && selectedKey ? share.notes.filter((n) => n.citekey === selectedKey) : []),
    [share, selectedKey],
  );

  const onJoin = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const stored = localStorage.getItem(VISITOR_KEY(token)) ?? undefined;
      const { visitor, share: view } = await joinLibraryShare(token, {
        visitorId: stored,
        name: name.trim() || undefined,
      });
      localStorage.setItem(VISITOR_KEY(token), visitor.id);
      setVisitorId(visitor.id);
      setName(visitor.name);
      setJoined(true);
      setShare(view);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onNote = async () => {
    if (!token || !selectedKey || !noteDraft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { share: view } = await postLibraryShareNote(token, {
        citekey: selectedKey,
        body: noteDraft,
        visitorId: visitorId ?? undefined,
        authorName: name || undefined,
      });
      setShare(view);
      setNoteDraft("");
      if (view.visitor) {
        localStorage.setItem(VISITOR_KEY(token), view.visitor.id);
        setVisitorId(view.visitor.id);
        setJoined(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDownloadBundle = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const bundle = await fetchLibraryShareBundle(token);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `openleaf-share-${token.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus("Downloaded share bundle");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onAddToLibrary = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const result = await importLibraryShare({ token });
      setStatus(
        `Added ${result.count} to your library` +
          (result.skipped.length ? ` · skipped ${result.skipped.length}` : ""),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (gone) {
    return (
      <div className="guest-shell">
        <div className="guest-card">
          <h1>Share unavailable</h1>
          <p>This paper share link is expired or was stopped by the host.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell library-shell library-share-guest">
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src="/logo.png" alt="OpenLeaf logo" />
          <span className="brand-mark">OpenLeaf</span>
          <span className="brand-sub">shared papers</span>
        </div>
        <div className="topbar-end">
          {hostSignedIn ? (
            <Link to="/library" className="btn btn-quiet">
              My library
            </Link>
          ) : null}
          <ThemePicker compact />
        </div>
      </header>

      {error ? <div className="library-error">{error}</div> : null}
      {status ? <div className="library-share-status">{status}</div> : null}

      {!share ? (
        <div className="guest-shell guest-loading">Loading share…</div>
      ) : (
        <>
          <div className="library-share-guest-bar">
            <div>
              <h1 className="library-share-guest-title">{share.title}</h1>
              <p className="share-muted">
                {share.papers.length} paper{share.papers.length === 1 ? "" : "s"} · {share.role}
                {share.expiresAt ? ` · expires ${formatWhen(share.expiresAt)}` : " · no expiry"}
              </p>
            </div>
            <div className="library-share-guest-actions">
              {!joined ? (
                <div className="library-share-join">
                  <input
                    className="library-share-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                    disabled={busy}
                  />
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void onJoin()}>
                    Join
                  </button>
                </div>
              ) : (
                <span className="share-guest-badge" style={{ background: share.visitor?.color ?? "#3B82F6" }}>
                  {share.visitor?.name ?? name}
                </span>
              )}
              {share.allowExport ? (
                <>
                  <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void onDownloadBundle()}>
                    Download JSON
                  </button>
                  {hostSignedIn ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => void onAddToLibrary()}
                    >
                      Add to my library
                    </button>
                  ) : (
                    <span className="share-muted">Sign in as host to add to this machine’s library</span>
                  )}
                </>
              ) : null}
            </div>
          </div>

          <div className="library-master has-selection library-share-guest-grid">
            <ul className="library-list">
              {share.papers.map((p) => (
                <li key={p.citekey}>
                  <button
                    type="button"
                    className={`library-item${selectedKey === p.citekey ? " is-selected" : ""}`}
                    onClick={() => setSelectedKey(p.citekey)}
                  >
                    <div className="library-item-title">{p.title}</div>
                    <div className="library-item-meta">
                      {authorsLabel(p)}
                      {p.year != null ? ` · ${p.year}` : ""}
                    </div>
                  </button>
                </li>
              ))}
            </ul>

            <div className="library-detail">
              {selected ? (
                <>
                  <h2>{selected.title}</h2>
                  <p className="library-authors-full">{authorsLabel(selected)}</p>
                  <p className="muted">
                    {selected.venue || "—"}
                    {selected.year != null ? ` · ${selected.year}` : ""}
                  </p>
                  {selected.url ? (
                    <p>
                      <a href={selected.url} target="_blank" rel="noreferrer">
                        {selected.url}
                      </a>
                    </p>
                  ) : null}
                  {selected.doi ? <p>DOI: {selected.doi}</p> : null}
                  {selected.arxivId ? <p>arXiv: {selected.arxivId}</p> : null}
                  {selected.abstract ? <p className="library-abstract">{selected.abstract}</p> : null}
                  {selected.tags.length ? (
                    <p className="library-tags">
                      {selected.tags.map((t) => (
                        <span key={t} className="lib-badge">
                          {t}
                        </span>
                      ))}
                    </p>
                  ) : null}
                  {share.allowPdf && selected.hasPdf ? (
                    <p>
                      <a
                        className="btn btn-quiet"
                        href={librarySharePdfUrl(token, selected.citekey)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open PDF
                      </a>
                    </p>
                  ) : null}

                  <section className="library-share-notes">
                    <h3>Shared notes</h3>
                    {!paperNotes.length ? <p className="muted">No notes yet.</p> : null}
                    <ul className="library-share-note-list">
                      {paperNotes.map((n) => (
                        <li key={n.id} className="library-share-note">
                          <span className="library-share-note-author" style={{ color: n.authorColor }}>
                            {n.authorName}
                          </span>
                          <span className="share-muted"> · {formatWhen(n.createdAt)}</span>
                          <p>{n.body}</p>
                        </li>
                      ))}
                    </ul>
                    {share.role === "commenter" ? (
                      <div className="library-share-note-compose">
                        <textarea
                          className="library-share-input"
                          rows={3}
                          value={noteDraft}
                          onChange={(e) => setNoteDraft(e.target.value)}
                          placeholder="Leave a note for collaborators…"
                          disabled={busy}
                        />
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy || !noteDraft.trim()}
                          onClick={() => void onNote()}
                        >
                          Post note
                        </button>
                      </div>
                    ) : (
                      <p className="share-muted">This share is view-only.</p>
                    )}
                  </section>
                </>
              ) : (
                <p className="muted">Select a paper</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
