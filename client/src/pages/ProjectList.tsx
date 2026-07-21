import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { createProject, listProjects } from "../api/client";
import type { ProjectMeta } from "../api/types";
import { ThemeToggle } from "../components/ThemeToggle";

export function ProjectList() {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setProjects(await listProjects());
  };

  useEffect(() => {
    refresh().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : "Failed to load projects");
    });
  }, []);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    const id = name.trim();
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await createProject(id);
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
        <ThemeToggle />
      </header>
      <main className="home">
        <h1>Projects</h1>
        <p className="home-lead">
          Each project is a folder on disk with a main <code>.tex</code> file, bibliography, and
          figures. Open one to edit and compile side by side.
        </p>

        <form className="home-actions" onSubmit={onCreate}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="new-project-id"
            pattern="[a-zA-Z0-9._-]+"
            title="Letters, numbers, dots, underscores, hyphens"
          />
          <button className="btn btn-primary" type="submit" disabled={busy}>
            New from example
          </button>
        </form>

        {error && <div className="error-banner">{error}</div>}

        <div className="project-list">
          {projects.map((p) => (
            <Link key={p.id} to={`/p/${encodeURIComponent(p.id)}`} className="project-item">
              <div>
                <h2>{p.name}</h2>
                <p>
                  {p.mainFile} · {p.engine}
                </p>
              </div>
              <span className="badge">Open</span>
            </Link>
          ))}
          {projects.length === 0 && !error && (
            <div className="empty-hint">No projects yet. Create one above.</div>
          )}
        </div>
      </main>
    </div>
  );
}
