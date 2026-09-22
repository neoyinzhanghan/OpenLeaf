import { Link } from "react-router-dom";
import { hostLogout } from "../api/share";
import { LibraryPanel } from "../components/LibraryPanel";
import { ThemePicker } from "../components/ThemeToggle";
import { useSession } from "../session/SessionContext";

/** First-class citation library — independent of any project. */
export function LibraryPage() {
  const { session, refresh } = useSession();
  const remoteHost = session.kind === "host" && session.remote;

  return (
    <div className="app-shell library-shell">
      <header className="topbar">
        <div className="brand">
          <Link to="/" className="brand-home-link" title="Back to projects">
            <img className="brand-logo" src="/logo.png" alt="OpenLeaf logo" />
            <span className="brand-mark">OpenLeaf</span>
          </Link>
          <span className="brand-sub">citation library</span>
        </div>
        <nav className="topbar-nav" aria-label="Primary">
          <Link to="/" className="btn btn-quiet">
            Projects
          </Link>
          <Link to="/library" className="btn btn-quiet is-active" aria-current="page">
            Library
          </Link>
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
      <LibraryPanel open variant="page" onClose={() => undefined} />
    </div>
  );
}
