import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  getKnowledgeInbox,
  patchLibraryFact,
  type KnowledgeInboxGroup,
  type KnowledgeInboxItem,
} from "../api/client";
import { hostLogout } from "../api/share";
import { ErrorBanner } from "../components/ErrorBanner";
import { KnowledgeImpactPanel } from "../components/KnowledgeImpactPanel";
import { ThemePicker } from "../components/ThemeToggle";
import { readLastProject, type LastProject } from "../lib/lastProject";
import { useSession } from "../session/SessionContext";

function itemOpenHref(item: KnowledgeInboxItem): string | null {
  if (item.type === "fact" && item.citekey && item.factId) {
    return `/facts?paper=${encodeURIComponent(item.citekey)}&fact=${encodeURIComponent(item.factId)}&status=all&type=all`;
  }
  if (item.type === "fact" && item.citekey) {
    return `/facts?paper=${encodeURIComponent(item.citekey)}&status=all&type=all`;
  }
  if (item.type === "knowledge") {
    const id = item.id.startsWith("kn:") ? item.id : `kn:${item.id}`;
    return `/knowledge?focus=${encodeURIComponent(id)}`;
  }
  if (item.type === "project") {
    const id = item.id.startsWith("proj:") ? item.id.slice(5) : item.id;
    return `/p/${encodeURIComponent(id)}`;
  }
  return `/knowledge?focus=${encodeURIComponent(item.id)}`;
}

function impactNodeId(item: KnowledgeInboxItem): string {
  if (item.type === "fact") {
    return item.id.startsWith("fact:") ? item.id : `fact:${item.id}`;
  }
  return item.id;
}

export function ReviewInboxPage() {
  const { session, refresh } = useSession();
  const remoteHost = session.kind === "host" && session.remote;
  const [groups, setGroups] = useState<KnowledgeInboxGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [impactNode, setImpactNode] = useState<string | null>(null);
  const [lastProject, setLastProject] = useState<LastProject | null>(null);
  const [seenPassages, setSeenPassages] = useState<Set<string>>(() => {
    try {
      const raw = sessionStorage.getItem("openleaf.review.seenPassages");
      if (!raw) return new Set();
      const arr = JSON.parse(raw) as string[];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    setLastProject(readLastProject());
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem("openleaf.review.seenPassages", JSON.stringify([...seenPassages]));
    } catch {
      /* ignore */
    }
  }, [seenPassages]);

  const load = useCallback(async () => {
    try {
      const res = await getKnowledgeInbox();
      setGroups(res.groups);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load review inbox");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totalCount = useMemo(
    () => groups.reduce((n, g) => n + g.items.length, 0),
    [groups],
  );

  const confirmFact = async (item: KnowledgeInboxItem) => {
    if (!item.citekey || !item.factId) return;
    const key = `${item.citekey}:${item.factId}`;
    if (!seenPassages.has(key)) {
      setError("Open the passage at least once before confirming — this keeps rubber-stamping from slipping through.");
      return;
    }
    setBusyId(key);
    try {
      await patchLibraryFact(item.citekey, item.factId, { status: "confirmed" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not confirm fact");
    } finally {
      setBusyId(null);
    }
  };

  const rejectFact = async (item: KnowledgeInboxItem) => {
    if (!item.citekey || !item.factId) return;
    const key = `${item.citekey}:${item.factId}`;
    setBusyId(key);
    try {
      await patchLibraryFact(item.citekey, item.factId, { status: "rejected" });
      setImpactNode(impactNodeId(item));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reject fact");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="app-shell review-shell">
      <header className="topbar">
        <div className="brand">
          <Link to="/" className="brand-home-link" title="Back to projects">
            <img className="brand-logo" src="/logo.png" alt="OpenLeaf logo" />
            <span className="brand-mark">OpenLeaf</span>
          </Link>
          <span className="brand-sub">review inbox</span>
        </div>
        <nav className="topbar-nav" aria-label="Primary">
          <Link to="/" className="btn btn-quiet">
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
          <Link to="/review" className="btn btn-quiet is-active" aria-current="page">
            Review
            {totalCount > 0 ? <span className="nav-badge">{totalCount}</span> : null}
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

      <main className="review-main">
        <h1>Review</h1>
        <p className="review-lead">
          Unreviewed facts, steps that need a fresh look, and anything flagged by upstream changes. Only you can confirm
          or reject.
        </p>

        {error ? <ErrorBanner onDismiss={() => setError(null)}>{error}</ErrorBanner> : null}

        {groups.length === 0 && !error ? (
          <div className="empty-hint empty-hint-card">
            <strong>Inbox clear</strong>
            <p>No unreviewed facts or flagged items right now.</p>
          </div>
        ) : null}

        {groups.map((group) => (
          <section key={`${group.kind}:${group.title}`} className="review-group">
            <div className="review-group-head">
              <h2>{group.title}</h2>
              <span className="review-count">{group.items.length}</span>
            </div>
            {group.items.map((item) => {
              const rowKey = item.factId && item.citekey ? `${item.citekey}:${item.factId}` : item.id;
              const href = itemOpenHref(item);
              const busy = busyId === rowKey;
              return (
                <div key={rowKey} className="review-row">
                  <div>
                    <div className="review-row-label">
                      <span className="knowledge-kind-dot" data-kind={item.type === "step" ? "knowledge" : item.type} />
                      {item.label || item.id}
                    </div>
                    <div className="review-row-meta">
                      {item.type}
                      {item.citekey ? ` · ${item.citekey}` : ""}
                      {item.createdBy ? ` · ${item.createdBy}` : ""}
                      {` · ${item.status}`}
                    </div>
                  </div>
                  <div className="review-row-actions">
                    {item.type === "fact" && item.citekey && item.factId ? (
                      <>
                        <Link
                          to={`/facts?paper=${encodeURIComponent(item.citekey)}&fact=${encodeURIComponent(item.factId)}&status=all&type=all`}
                          className="btn btn-quiet"
                          onClick={() => {
                            setSeenPassages((prev) => new Set(prev).add(`${item.citekey}:${item.factId}`));
                          }}
                        >
                          See passage
                        </Link>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy}
                          onClick={() => void confirmFact(item)}
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={busy}
                          onClick={() => void rejectFact(item)}
                        >
                          Reject
                        </button>
                      </>
                    ) : null}
                    {href ? (
                      <Link to={href} className="btn btn-quiet">
                        Open
                      </Link>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={() => setImpactNode(impactNodeId(item))}
                    >
                      Impact
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        ))}
      </main>

      <KnowledgeImpactPanel nodeId={impactNode} onClose={() => setImpactNode(null)} />

      <nav className={`phone-tabbar${lastProject ? " has-project" : ""} has-knowledge`} aria-label="Primary">
        <Link to="/">Projects</Link>
        {lastProject ? (
          <Link to={`/p/${encodeURIComponent(lastProject.id)}`} className="phone-tabbar-project">
            <span>{lastProject.name}</span>
          </Link>
        ) : null}
        <Link to="/library">Library</Link>
        <Link to="/facts">Facts</Link>
        <Link to="/knowledge">Knowledge</Link>
        <Link to="/review" aria-current="page">
          Review
        </Link>
      </nav>
    </div>
  );
}
