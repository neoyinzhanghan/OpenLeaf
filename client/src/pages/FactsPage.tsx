import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { hostLogout } from "../api/share";
import { listLibraryPapers } from "../api/client";
import type { PaperRecord } from "../api/types";
import { ErrorBanner } from "../components/ErrorBanner";
import { LibraryFactsView } from "../components/LibraryFactsView";
import { ThemePicker } from "../components/ThemeToggle";
import { readLastProject, type LastProject } from "../lib/lastProject";
import { isTransientPdfErrorMessage } from "../lib/transientErrors";
import { useSession } from "../session/SessionContext";

/** First-class fact review — PDF on one side, queue on the other. */
export function FactsPage() {
  const { session, refresh } = useSession();
  const remoteHost = session.kind === "host" && session.remote;
  const [params] = useSearchParams();
  const [papers, setPapers] = useState<PaperRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastProject, setLastProject] = useState<LastProject | null>(null);
  const libraryHref = params.get("paper")
    ? `/library?paper=${encodeURIComponent(params.get("paper")!)}`
    : "/library";

  useEffect(() => {
    setLastProject(readLastProject());
  }, []);

  const load = useCallback(async () => {
    try {
      const { papers: list } = await listLibraryPapers({ limit: 500 });
      setPapers(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load library papers");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="app-shell library-shell facts-shell">
      <header className="topbar">
        <div className="brand">
          <Link to="/" className="brand-home-link" title="Back to projects">
            <img className="brand-logo" src="/logo.png" alt="OpenLeaf logo" />
            <span className="brand-mark">OpenLeaf</span>
          </Link>
          <span className="brand-sub">fact review</span>
        </div>
        <nav className="topbar-nav" aria-label="Primary">
          <Link to="/" className="btn btn-quiet">
            Projects
          </Link>
          <Link to={libraryHref} className="btn btn-quiet" title="Open Library (keeps current paper when filtered)">
            Library
          </Link>
          <Link to="/facts" className="btn btn-quiet is-active" aria-current="page">
            Facts
          </Link>
          <Link to="/knowledge" className="btn btn-quiet">
            Knowledge
          </Link>
          <Link to="/review" className="btn btn-quiet">
            Review
          </Link>
          {lastProject ? (
            <Link to={`/p/${encodeURIComponent(lastProject.id)}`} className="btn btn-quiet topbar-wide-only">
              {lastProject.name}
            </Link>
          ) : null}
        </nav>
        <div className="topbar-end">
          {remoteHost && (
            <button
              type="button"
              className="btn btn-ghost btn-quiet"
              onClick={() => {
                void hostLogout().finally(() => void refresh());
              }}
            >
              Sign out
            </button>
          )}
          <ThemePicker compact />
        </div>
      </header>
      {error ? (
        <ErrorBanner className="library-error" onDismiss={() => setError(null)}>
          {error}
        </ErrorBanner>
      ) : null}
      <LibraryFactsView
        papers={papers}
        onError={(msg) => {
          if (!isTransientPdfErrorMessage(msg)) setError(msg);
        }}
      />
      <nav className={`phone-tabbar${lastProject ? " has-project" : ""} has-knowledge`} aria-label="Primary">
        <Link to="/">Projects</Link>
        {lastProject ? (
          <Link to={`/p/${encodeURIComponent(lastProject.id)}`} className="phone-tabbar-project">
            <span>{lastProject.name}</span>
          </Link>
        ) : null}
        <Link to={libraryHref}>Library</Link>
        <Link to="/facts" aria-current="page">
          Facts
        </Link>
        <Link to="/knowledge">Knowledge</Link>
        <Link to="/review">Review</Link>
      </nav>
    </div>
  );
}
