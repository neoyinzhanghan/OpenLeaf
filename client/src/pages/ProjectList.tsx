import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { createProject, listProjects } from "../api/client";
import { hostGateway, hostLogout, type HostGatewayView } from "../api/share";
import type { ProjectMeta } from "../api/types";
import { ThemePicker } from "../components/ThemeToggle";
import { copyText } from "../lib/clipboard";
import { useSession } from "../session/SessionContext";

export function ProjectList() {
  const { session, refresh } = useSession();
  const remoteHost = session.kind === "host" && session.remote;
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [gateway, setGateway] = useState<HostGatewayView | null>(null);
  const [copied, setCopied] = useState(false);

  const refreshProjects = async () => {
    setProjects(await listProjects());
  };

  useEffect(() => {
    refreshProjects()
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load projects");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (remoteHost) return;
    let cancelled = false;
    const pull = async () => {
      try {
        const g = await hostGateway();
        if (!cancelled) setGateway(g);
        return g;
      } catch {
        return null;
      }
    };
    void pull();
    const t = window.setInterval(() => {
      void pull().then((g) => {
        if (g && (g.dnsReady || g.localOnly || g.status === "error")) {
          window.clearInterval(t);
        }
      });
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [remoteHost]);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    const id = name.trim();
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await createProject(id, "example-article");
      setName("");
      await refreshProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create project");
    } finally {
      setBusy(false);
    }
  };

  const publicUrl = gateway && !gateway.localOnly && gateway.url ? gateway.url : null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src="/logo.png" alt="OpenLeaf logo" />
          <span className="brand-mark">OpenLeaf</span>
          <span className="brand-sub">local LaTeX</span>
        </div>
        <nav className="topbar-nav" aria-label="Primary">
          <Link to="/" className="btn btn-quiet is-active" aria-current="page">
            Projects
          </Link>
          <Link to="/library" className="btn btn-quiet">
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
      <main className="home">
        <h1>Projects</h1>
        <p className="home-lead">
          Local folders with a main <code>.tex</code>, bibliography, and figures — edit and compile side by side.
          Your personal reference collection lives separately in{" "}
          <Link to="/library">Library</Link>.
        </p>

        {remoteHost && (
          <div className="host-gateway-card is-remote">
            <p className="guest-kicker">Phone / remote</p>
            <p>You’re on the public host link. Keep this tab signed in to edit from this device.</p>
          </div>
        )}

        {!remoteHost && publicUrl && (
          <div className="host-gateway-card">
            <p className="guest-kicker">Open on your phone</p>
            <p>
              Persistent Cloudflare URL for this machine. Sign in as <strong>admin</strong> with the host
              password. The address changes if OpenLeaf or the tunnel restarts.
            </p>
            <div className="host-gateway-url-row">
              <code className="host-gateway-url">{publicUrl}</code>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  void copyText(publicUrl).then((ok) => {
                    if (!ok) {
                      setError("Could not copy the URL — select it and copy manually");
                      return;
                    }
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1600);
                  });
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            {gateway && !gateway.dnsReady && (
              <p className="home-actions-hint">DNS is still propagating — wait a few seconds, then open it.</p>
            )}
          </div>
        )}

        {!remoteHost && gateway?.localOnly && (
          <div className="host-gateway-card">
            <p className="guest-kicker">Phone access</p>
            <p>
              No public Cloudflare tunnel yet. Install <code>cloudflared</code> on this machine, then restart
              OpenLeaf to get a link you can open on your phone.
            </p>
          </div>
        )}

        <form className="home-actions" onSubmit={onCreate}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="methods-draft"
            pattern="[a-zA-Z0-9._-]+"
            title="Letters, numbers, dots, underscores, hyphens"
            aria-label="New project id"
          />
          <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create from example"}
          </button>
        </form>
        <p className="home-actions-hint">
          Seeds a starter article you can rename and rewrite. Id: letters, numbers, <code>.</code> <code>_</code>{" "}
          <code>-</code>.
        </p>

        {error && <div className="error-banner">{error}</div>}

        <div className="project-list">
          {loading && (
            <div className="empty-hint" role="status" aria-live="polite">
              Loading projects…
            </div>
          )}
          {!loading &&
            projects.map((p) => (
              <Link key={p.id} to={`/p/${encodeURIComponent(p.id)}`} className="project-item">
                <div>
                  <h2>{p.name}</h2>
                  <p>
                    {p.mainFile} · {p.engine}
                  </p>
                </div>
                <span className="project-item-go" aria-hidden>
                  →
                </span>
              </Link>
            ))}
          {!loading && projects.length === 0 && !error && (
            <div className="empty-hint empty-hint-card">
              <strong>No projects yet</strong>
              <p>
                Pick an id like <code>thesis-ch2</code> above, then create from the example template.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
