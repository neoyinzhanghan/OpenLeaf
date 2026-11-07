import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { hostLogout } from "../api/share";
import { LibraryPanel } from "../components/LibraryPanel";
import { ThemePicker } from "../components/ThemeToggle";
import { readLastProject, type LastProject } from "../lib/lastProject";
import { useSession } from "../session/SessionContext";

/** First-class citation library — independent of any project. */
export function LibraryPage() {
  const { session, refresh } = useSession();
  const remoteHost = session.kind === "host" && session.remote;
  const [params] = useSearchParams();
  const focusCitekey = params.get("paper");
  const [lastProject, setLastProject] = useState<LastProject | null>(null);
  useEffect(() => {
    setLastProject(readLastProject());
  }, []);

  return (
    <div className="app-shell library-shell">
      <header className="topbar">
        <div className="brand">
          <Link to="/" className="brand-home-link" title="Back to projects">
            <img className="brand-logo" src="/logo.png" alt="OpenLeaf logo" />
            <span className="brand-mark">OpenLeaf</span>
          </Link>
          <span className="brand-sub">library</span>
        </div>
        <nav className="topbar-nav" aria-label="Primary">
          <Link to="/" className="btn btn-quiet">
            Projects
          </Link>
          <Link to="/library" className="btn btn-quiet is-active" aria-current="page">
            Library
          </Link>
          <Link
            to={focusCitekey ? `/facts?paper=${encodeURIComponent(focusCitekey)}` : "/facts"}
            className="btn btn-quiet"
            title={focusCitekey ? `Review facts for ${focusCitekey}` : "Review extracted facts"}
          >
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
      <LibraryPanel open variant="page" focusCitekey={focusCitekey} onClose={() => undefined} />
      <nav className={`phone-tabbar${lastProject ? " has-project" : ""} has-knowledge`} aria-label="Primary">
        <Link to="/">Projects</Link>
        {lastProject ? (
          <Link to={`/p/${encodeURIComponent(lastProject.id)}`} className="phone-tabbar-project">
            <span>{lastProject.name}</span>
          </Link>
        ) : null}
        <Link to="/library" aria-current="page">
          Library
        </Link>
        <Link to={focusCitekey ? `/facts?paper=${encodeURIComponent(focusCitekey)}` : "/facts"}>
          Facts
        </Link>
        <Link to="/knowledge">Knowledge</Link>
        <Link to="/review">Review</Link>
      </nav>
    </div>
  );
}
