import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { renameProject } from "../api/client";
import type { ProjectMeta } from "../api/types";
import { projectFolderName } from "../projectFolder";

export function CopyPathMenuItem({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setFailed(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setFailed(true);
    }
  };

  return (
    <>
      <button type="button" role="menuitem" onClick={() => void copy()}>
        {failed ? "Select the path below" : copied ? "Copied" : "Copy path"}
      </button>
      <code className="project-path">{path}</code>
    </>
  );
}

export function ProjectNameField({
  project,
  variant = "card",
  onRenamed,
  onEditingChange,
}: {
  project: ProjectMeta;
  variant?: "card" | "toolbar";
  onRenamed?: (next: ProjectMeta) => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipCommit = useRef(false);
  const savingRef = useRef(false);
  const toolbar = variant === "toolbar";
  const nextName = draft.trim();
  const unchanged = nextName === project.name.trim();
  const folder = nextName ? projectFolderName(nextName) : null;

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const close = () => {
    skipCommit.current = true;
    setEditing(false);
    setDraft(project.name);
    setError(null);
    onEditingChange?.(false);
  };

  const start = () => {
    skipCommit.current = false;
    setDraft(project.name);
    setError(null);
    setEditing(true);
    onEditingChange?.(true);
  };

  const commit = async () => {
    if (skipCommit.current) {
      skipCommit.current = false;
      return;
    }
    if (savingRef.current) return;
    if (!nextName || unchanged) {
      close();
      return;
    }
    if (!folder) {
      setError("That name cannot be saved as a folder");
      inputRef.current?.focus();
      return;
    }
    savingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await renameProject(project.id, nextName);
      skipCommit.current = true;
      setEditing(false);
      onEditingChange?.(false);
      onRenamed?.(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename project");
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void commit();
  };

  const widthCh = Math.min(toolbar ? 22 : 48, Math.max(draft.length + 1, 8));

  return (
    <div className={`project-name${toolbar ? " is-toolbar" : ""}`}>
      {editing ? (
        <form className="project-name-form" onSubmit={onSubmit}>
          <input
            ref={inputRef}
            className={`project-name-input${toolbar ? " toolbar-project-name is-editing" : ""}`}
            style={{ width: `${widthCh}ch` }}
            value={draft}
            size={toolbar ? 1 : undefined}
            aria-label="Rename project"
            title={error ?? (!unchanged && folder && folder !== nextName ? folder : undefined)}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                skipCommit.current = true;
                close();
              } else if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              }
            }}
          />
        </form>
      ) : (
        <button
          type="button"
          className={`project-name-btn${toolbar ? " toolbar-project-name" : ""}`}
          title="Rename"
          onClick={start}
        >
          {project.name}
        </button>
      )}
      {!toolbar && editing && !unchanged && folder && folder !== nextName ? (
        <span className="project-name-hint">
          <code>{folder}</code>
        </span>
      ) : null}
      {error ? <span className="project-name-error">{error}</span> : null}
    </div>
  );
}

function ProjectCardMenu({ project }: { project: ProjectMeta }) {
  const path = project.path?.trim() ?? "";
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!path) return null;

  return (
    <div className="project-card-menu-wrap" ref={rootRef}>
      <button
        type="button"
        className="btn btn-ghost btn-icon project-card-more"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Project actions"
        title="Project actions"
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
          <circle cx="5" cy="12" r="1.6" fill="currentColor" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" />
          <circle cx="19" cy="12" r="1.6" fill="currentColor" />
        </svg>
      </button>
      {open ? (
        <div className="toolbar-menu project-card-menu" role="menu" aria-label="Project actions">
          <CopyPathMenuItem path={path} />
        </div>
      ) : null}
    </div>
  );
}

export function ProjectCard({
  project,
  onRenamed,
}: {
  project: ProjectMeta;
  onRenamed: (next: ProjectMeta) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <article className={`project-item${editing ? " is-renaming" : ""}`}>
      <Link className="project-item-hit" to={`/p/${encodeURIComponent(project.id)}`} aria-label={`Open ${project.name}`} />
      <div className="project-item-main">
        <h2>
          <ProjectNameField project={project} onRenamed={onRenamed} onEditingChange={setEditing} />
        </h2>
        <p>
          {project.mainFile} · {project.engine}
        </p>
      </div>
      <ProjectCardMenu project={project} />
      <span className="project-item-go" aria-hidden>
        →
      </span>
    </article>
  );
}
