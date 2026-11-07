import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { createKnowledgeItem, createProjectNamed, listProjects } from "../api/client";
import { hostGateway, hostLogout, type HostGatewayView } from "../api/share";
import type { ProjectMeta } from "../api/types";
import { ErrorBanner } from "../components/ErrorBanner";
import { HostAccessPanel } from "../components/HostAccessPanel";
import { ProjectCard } from "../components/ProjectHostActions";
import { ThemePicker } from "../components/ThemeToggle";
import { readLastProject, rememberProject, type LastProject } from "../lib/lastProject";
import { projectFolderName } from "../projectFolder";
import { useSession } from "../session/SessionContext";

type ProjectFilter = "all" | "papers" | "knowledge";

function isPaper(p: ProjectMeta): boolean {
  return p.kind === "paper";
}

function isKnowledge(p: ProjectMeta): boolean {
  return p.kind === "knowledge";
}

export function ProjectList() {
  const { session, refresh } = useSession();
  const navigate = useNavigate();
  const [lastProject, setLastProject] = useState<LastProject | null>(null);
  useEffect(() => {
    setLastProject(readLastProject());
  }, []);
  const [params] = useSearchParams();
  const remoteHost = session.kind === "host" && session.remote;
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [knBusy, setKnBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [gateway, setGateway] = useState<HostGatewayView | null>(null);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const title = name.trim();
  const folder = title ? projectFolderName(title) : null;

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

  const papers = useMemo(() => projects.filter(isPaper), [projects]);
  const knowledge = useMemo(() => projects.filter(isKnowledge), [projects]);
  const other = useMemo(
    () => projects.filter((p) => !isPaper(p) && !isKnowledge(p)),
    [projects],
  );

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!title || !folder) return;
    setBusy(true);
    setError(null);
    try {
      await createProjectNamed(title, "example-article");
      setName("");
      await refreshProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create project");
    } finally {
      setBusy(false);
    }
  };

  const onCreateKnowledge = async () => {
    const knTitle = title || window.prompt("Knowledge item title", "New knowledge item");
    if (!knTitle?.trim()) return;
    setKnBusy(true);
    setError(null);
    try {
      const { project } = await createKnowledgeItem({ title: knTitle.trim() });
      setName("");
      rememberProject({ id: project.id, name: project.name });
      navigate(`/p/${encodeURIComponent(project.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create knowledge item");
    } finally {
      setKnBusy(false);
    }
  };

  const onRenamed = (prev: ProjectMeta) => (next: ProjectMeta) => {
    const last = readLastProject();
    if (last && (last.id === prev.id || last.id === next.id)) {
      rememberProject({ id: next.id, name: next.name });
      setLastProject({ id: next.id, name: next.name });
    }
    void refreshProjects();
  };

  const emptyLabel =
    filter === "knowledge" ? "knowledge items" : filter === "papers" ? "papers" : "projects";

  const showPapers = filter === "all" || filter === "papers";
  const showKnowledge = filter === "all" || filter === "knowledge";
  const showOther = filter === "all";
  const nothingVisible =
    !loading &&
    ((filter === "papers" && papers.length === 0) ||
      (filter === "knowledge" && knowledge.length === 0) ||
      (filter === "all" && projects.length === 0));

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
          <Link to="/facts" className="btn btn-quiet">
            Facts
          </Link>
          <Link to="/knowledge" className="btn btn-quiet">
            Knowledge
          </Link>
          <Link to="/review" className="btn btn-quiet">
            Review
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
        {params.get("pair") === "invalid" && (
          <div className="error-banner">
            This link has expired or was already used. On your computer, open OpenLeaf → Open on your phone → New
            link.
          </div>
        )}
        <p className="home-lead">
          Authored papers and short knowledge write-ups share the editor, but they are not the same kind of thing.
          Reference material lives in <Link to="/library">Library</Link>.
        </p>

        {remoteHost && (
          <div className="host-gateway-card is-remote">
            <p className="guest-kicker">Phone / remote</p>
            <p>You’re on the public host link. Keep this tab signed in to edit from this device.</p>
          </div>
        )}

        {!remoteHost && (
          <div className="host-gateway-card">
            <p className="guest-kicker">Open on your phone</p>
            <p>Same Wi-Fi uses a one-time link. From anywhere starts a tunnel only when you ask for it.</p>
            <button type="button" className="btn btn-primary" onClick={() => setPhoneOpen(true)}>
              Open on your phone
            </button>
            {gateway?.url && !gateway.localOnly ? (
              <p className="home-actions-hint">A remote tunnel is already running. The phone dialog can reuse it.</p>
            ) : null}
          </div>
        )}

        <div className="project-filter-tabs" role="tablist" aria-label="Project kind">
          {(
            [
              ["all", "All"],
              ["papers", "Papers"],
              ["knowledge", "Knowledge"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={filter === id}
              className={filter === id ? "is-active" : undefined}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <form className="home-actions is-split" onSubmit={onCreate}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My first paper"
            aria-label="New project name"
          />
          <button className="btn btn-primary" type="submit" disabled={busy || !title || !folder}>
            {busy ? "Creating…" : "Create paper"}
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={knBusy}
            onClick={() => void onCreateKnowledge()}
          >
            {knBusy ? "Creating…" : "New knowledge item"}
          </button>
        </form>
        {title && folder && folder !== title ? (
          <p className="home-actions-hint">
            Folder name: <code>{folder}</code>
          </p>
        ) : null}
        <p className="home-actions-hint">
          Papers get the article template. Knowledge items are short ring-marked write-ups with a stable{" "}
          <code>\kn</code> id. Click a title to rename.
        </p>
        {!remoteHost && <HostAccessPanel open={phoneOpen} onClose={() => setPhoneOpen(false)} />}

        {error ? <ErrorBanner onDismiss={() => setError(null)}>{error}</ErrorBanner> : null}

        {loading && (
          <div className="empty-hint" role="status" aria-live="polite">
            Loading projects…
          </div>
        )}

        {!loading && showPapers && papers.length > 0 ? (
          <section className="project-section project-section-papers" aria-labelledby="papers-heading">
            {filter === "all" ? (
              <header className="project-section-head">
                <h2 id="papers-heading">Papers</h2>
                <p>Authored manuscripts with a full article layout.</p>
              </header>
            ) : (
              <h2 id="papers-heading" className="sr-only">
                Papers
              </h2>
            )}
            <div className="project-list is-papers">
              {papers.map((p) => (
                <ProjectCard key={p.id} project={p} onRenamed={onRenamed(p)} />
              ))}
            </div>
          </section>
        ) : null}

        {!loading && showKnowledge && knowledge.length > 0 ? (
          <section className="project-section project-section-knowledge" aria-labelledby="knowledge-heading">
            {filter === "all" ? (
              <header className="project-section-head">
                <h2 id="knowledge-heading">Knowledge</h2>
                <p>Short write-ups — not papers. Open one to edit the claim.</p>
              </header>
            ) : (
              <h2 id="knowledge-heading" className="sr-only">
                Knowledge
              </h2>
            )}
            <div className="project-list is-knowledge">
              {knowledge.map((p) => (
                <ProjectCard key={p.id} project={p} onRenamed={onRenamed(p)} />
              ))}
            </div>
          </section>
        ) : null}

        {!loading && showOther && other.length > 0 ? (
          <section className="project-section project-section-other" aria-labelledby="other-heading">
            <header className="project-section-head">
              <h2 id="other-heading">Limbo</h2>
              <p>Benches, talks, and folders that are neither papers nor knowledge items.</p>
            </header>
            <div className="project-list is-other">
              {other.map((p) => (
                <ProjectCard key={p.id} project={p} onRenamed={onRenamed(p)} />
              ))}
            </div>
          </section>
        ) : null}

        {nothingVisible && !error ? (
          <div className="empty-hint empty-hint-card">
            <strong>No {emptyLabel} yet</strong>
            <p>
              {filter === "knowledge"
                ? "Use “New knowledge item” above to start a short write-up."
                : "Pick a name above, then create a paper from the example template."}
            </p>
          </div>
        ) : null}
      </main>
      <nav className={`phone-tabbar${lastProject ? " has-project" : ""} has-knowledge`} aria-label="Primary">
        <Link to="/" aria-current="page">
          Projects
        </Link>
        {lastProject ? (
          <Link to={`/p/${encodeURIComponent(lastProject.id)}`} className="phone-tabbar-project">
            <span>{lastProject.name}</span>
          </Link>
        ) : null}
        <Link to="/library">Library</Link>
        <Link to="/facts">Facts</Link>
        <Link to="/knowledge">Knowledge</Link>
        <Link to="/review">Review</Link>
      </nav>
    </div>
  );
}
