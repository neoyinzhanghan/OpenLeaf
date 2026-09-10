import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { createProject, listProjects } from "../api/client";
import type { ProjectMeta } from "../api/types";
import { ThemePicker } from "../components/ThemeToggle";

export function ProjectList() {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setProjects(await listProjects());
  };

  useEffect(() => {
    refresh()
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load projects");
      })
      .finally(() => setLoading(false));
  }, []);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    const id = name.trim();
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await createProject(id, "example-article");
      setName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create project");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src="/logo.png" alt="OpenLeaf logo" />
          <span className="brand-mark">OpenLeaf</span>
          <span className="brand-sub">local LaTeX</span>
        </div>
        <ThemePicker compact />
      </header>
      <main className="home">
        <h1>Projects</h1>
        <p className="home-lead">
          Local folders with a main <code>.tex</code>, bibliography, and figures — edit and compile side by side.
        </p>

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
