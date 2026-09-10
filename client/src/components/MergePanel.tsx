import { useCallback, useEffect, useMemo, useState } from "react";
import {
  abortProjectMerge,
  completeProjectMerge,
  getProjectMerge,
  getProjectMergeFile,
  resolveProjectMerge,
  type MergeConflictFile,
  type MergeFileSides,
  type MergeSession,
} from "../api/client";
import type { TimelineView } from "../api/types";

type Props = {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onFinished: (timeline: TimelineView) => void;
  onSessionChange?: (session: MergeSession | null) => void;
};

type SideTab = "result" | "compare" | "ours" | "theirs" | "base";

function kindLabel(kind: MergeConflictFile["kind"]): string {
  switch (kind) {
    case "both-modified":
      return "Both modified";
    case "both-added":
      return "Both added";
    case "deleted-by-us":
      return "Deleted on current";
    case "deleted-by-them":
      return "Deleted on incoming";
    default:
      return "Conflict";
  }
}

function isDeleteKind(kind: MergeConflictFile["kind"] | undefined): boolean {
  return kind === "deleted-by-us" || kind === "deleted-by-them";
}

function hasConflictMarkers(text: string): boolean {
  return /^<<<<<<< /m.test(text) || /^>>>>>>> /m.test(text) || /^=======/m.test(text);
}

function MarkerPreview({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <pre className="merge-marker-preview" aria-label="File preview">
      {lines.map((line, i) => {
        let cls = "merge-line";
        if (line.startsWith("<<<<<<<")) cls += " is-ours-mark";
        else if (line.startsWith(">>>>>>>")) cls += " is-theirs-mark";
        else if (line.startsWith("=======")) cls += " is-sep-mark";
        return (
          <span key={i} className={cls}>
            {line || " "}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

export function MergePanel({
  projectId,
  open,
  onClose,
  onFinished,
  onSessionChange,
}: Props) {
  const [session, setSession] = useState<MergeSession | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [sides, setSides] = useState<MergeFileSides | null>(null);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<SideTab>("result");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const applySession = useCallback(
    (next: MergeSession | null) => {
      setSession(next);
      onSessionChange?.(next);
    },
    [onSessionChange],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await getProjectMerge(projectId);
      applySession(next);
      if (next) {
        setMessage((m) => m || next.message);
        const firstOpen =
          next.conflicts.find((c) => !c.resolved)?.path ?? next.conflicts[0]?.path ?? null;
        setSelectedPath((cur) => {
          if (cur && next.conflicts.some((c) => c.path === cur)) return cur;
          return firstOpen;
        });
      } else {
        setSelectedPath(null);
        setSides(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load merge");
    } finally {
      setLoading(false);
    }
  }, [projectId, applySession]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, projectId, refresh]);

  useEffect(() => {
    if (!open || !selectedPath || !session) {
      setSides(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const file = await getProjectMergeFile(projectId, selectedPath);
        if (cancelled) return;
        setSides(file);
        setDraft(file.working ?? file.ours ?? file.theirs ?? "");
        setTab(file.binary ? "ours" : "result");
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load conflict file");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId, selectedPath, session?.id]);

  const selectedConflict = useMemo(
    () => session?.conflicts.find((c) => c.path === selectedPath) ?? null,
    [session, selectedPath],
  );

  const resolvedCount = useMemo(
    () => session?.conflicts.filter((c) => c.resolved).length ?? 0,
    [session],
  );
  const totalConflicts = session?.conflicts.length ?? 0;
  const unresolved = totalConflicts - resolvedCount;
  const ready = Boolean(session && unresolved === 0);
  const progressPct = totalConflicts === 0 ? 100 : Math.round((resolvedCount / totalConflicts) * 100);
  const markersPresent = tab === "result" && !sides?.binary && hasConflictMarkers(draft);

  const oursLabel = isDeleteKind(selectedConflict?.kind)
    ? selectedConflict?.kind === "deleted-by-us"
      ? "Keep deletion"
      : "Keep current file"
    : "Use current";
  const theirsLabel = isDeleteKind(selectedConflict?.kind)
    ? selectedConflict?.kind === "deleted-by-them"
      ? "Accept deletion"
      : "Take incoming file"
    : "Use incoming";

  const onResolve = async (strategy: "ours" | "theirs" | "manual") => {
    if (!selectedPath) return;
    if (strategy === "manual" && hasConflictMarkers(draft)) {
      setError("Remove conflict markers (<<<<<<< / ======= / >>>>>>>) before marking resolved");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await resolveProjectMerge(projectId, {
        path: selectedPath,
        strategy,
        content: strategy === "manual" ? draft : undefined,
      });
      applySession(next);
      const nextOpen = next.conflicts.find((c) => !c.resolved)?.path ?? selectedPath;
      setSelectedPath(nextOpen);
      if (nextOpen === selectedPath) {
        const file = await getProjectMergeFile(projectId, selectedPath);
        setSides(file);
        setDraft(file.working ?? file.ours ?? file.theirs ?? "");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resolve failed");
    } finally {
      setBusy(false);
    }
  };

  const onComplete = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await completeProjectMerge(projectId, {
        message: message.trim() || undefined,
      });
      applySession(null);
      onFinished(result.timeline);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Complete failed");
    } finally {
      setBusy(false);
    }
  };

  const onAbort = async () => {
    if (!window.confirm("Abort this merge and restore the target tip? Conflict work will be discarded.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await abortProjectMerge(projectId);
      applySession(null);
      onFinished(result.timeline);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Abort failed");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const preview =
    tab === "ours"
      ? sides?.ours
      : tab === "theirs"
        ? sides?.theirs
        : tab === "base"
          ? sides?.base
          : draft;

  return (
    <aside className="merge-panel" aria-label="Merge conflicts">
      <div className="merge-panel-head">
        <div className="merge-panel-titleblock">
          <strong>Merge review</strong>
          {session && (
            <div className="merge-flow" aria-label="Merge direction">
              <span className="merge-flow-chip is-source" title="Incoming tip">
                {session.sourceBranchName}
              </span>
              <span className="merge-flow-arrow" aria-hidden>
                →
              </span>
              <span className="merge-flow-chip is-target" title="Current tip (receives changes)">
                {session.targetBranchName}
              </span>
              {session.autoMerged.length > 0 && (
                <span className="merge-flow-meta">{session.autoMerged.length} auto-merged</span>
              )}
            </div>
          )}
        </div>
        <div className="history-drawer-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void refresh()} disabled={busy || loading}>
            Refresh
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            title="Hide keeps the merge running — reopen from the toolbar Merge button"
          >
            Hide
          </button>
        </div>
      </div>

      {session && (
        <div className="merge-progress" aria-label="Conflict progress">
          <div className="merge-progress-track">
            <div className="merge-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <span className="merge-progress-label">
            {totalConflicts === 0
              ? "No conflicts — ready to complete"
              : `${resolvedCount} of ${totalConflicts} resolved`}
          </span>
          <span className="merge-progress-hint">Hide keeps this merge open · Abort cancels it</span>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {!session && !loading && <div className="merge-empty">No merge in progress.</div>}

      {session && (
        <>
          <div className="merge-body">
            <div className="merge-file-list" role="list">
              {session.conflicts.length === 0 ? (
                <div className="merge-empty-inline">No conflicts — ready to complete.</div>
              ) : (
                session.conflicts.map((c) => (
                  <button
                    key={c.path}
                    type="button"
                    role="listitem"
                    className={[
                      "merge-file-item",
                      c.path === selectedPath ? "is-selected" : "",
                      c.resolved ? "is-resolved" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => setSelectedPath(c.path)}
                    disabled={busy}
                  >
                    <span className="merge-file-status" aria-hidden>
                      {c.resolved ? "✓" : "!"}
                    </span>
                    <span className="merge-file-meta">
                      <span className="merge-file-path">{c.path}</span>
                      <span className="merge-file-kind">
                        {kindLabel(c.kind)}
                        {c.binary ? " · binary" : ""}
                        {c.strategy ? ` · ${c.strategy}` : ""}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>

            <div className="merge-editor">
              {!selectedPath && session.conflicts.length > 0 && (
                <div className="merge-empty-inline">Select a conflicted file to review.</div>
              )}
              {selectedPath && sides && (
                <>
                  <div className="merge-editor-toolbar">
                    <div className="merge-tabs">
                      {(
                        [
                          ["result", "Result"],
                          ["compare", "Compare"],
                          ["ours", "Current"],
                          ["theirs", "Incoming"],
                          ["base", "Base"],
                        ] as const
                      ).map(([t, label]) => (
                        <button
                          key={t}
                          type="button"
                          className={`merge-tab${tab === t ? " is-active" : ""}`}
                          onClick={() => setTab(t)}
                          disabled={
                            busy ||
                            ((t === "result" || t === "compare") && Boolean(sides.binary))
                          }
                          title={
                            t === "ours"
                              ? session.targetBranchName
                              : t === "theirs"
                                ? session.sourceBranchName
                                : undefined
                          }
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="merge-resolve-actions">
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={busy}
                        onClick={() => void onResolve("ours")}
                      >
                        {oursLabel}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={busy}
                        onClick={() => void onResolve("theirs")}
                      >
                        {theirsLabel}
                      </button>
                      {!sides.binary && (
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy || tab !== "result" || markersPresent}
                          onClick={() => void onResolve("manual")}
                          title={
                            tab !== "result"
                              ? "Switch to Result to mark your edit resolved"
                              : markersPresent
                                ? "Remove conflict markers first"
                                : undefined
                          }
                        >
                          Mark resolved
                        </button>
                      )}
                    </div>
                  </div>

                  {sides.binary ? (
                    <div className="merge-binary-note">
                      Binary conflict — choose <strong>{oursLabel}</strong> or <strong>{theirsLabel}</strong>.
                      Path: <code>{selectedPath}</code>
                    </div>
                  ) : tab === "compare" ? (
                    <div className="merge-compare">
                      <div className="merge-compare-pane">
                        <header>Current · {session.targetBranchName}</header>
                        <MarkerPreview text={sides.ours ?? "(missing)"} />
                      </div>
                      <div className="merge-compare-pane">
                        <header>Incoming · {session.sourceBranchName}</header>
                        <MarkerPreview text={sides.theirs ?? "(missing)"} />
                      </div>
                    </div>
                  ) : tab === "result" ? (
                    <div className="merge-result-wrap">
                      {markersPresent && (
                        <div className="merge-marker-banner">
                          Conflict markers still in Result — edit them out, or pick Current / Incoming.
                        </div>
                      )}
                      <textarea
                        className="merge-textarea"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        spellCheck={false}
                        disabled={busy}
                      />
                    </div>
                  ) : (
                    <MarkerPreview text={preview ?? ""} />
                  )}
                </>
              )}
            </div>
          </div>

          <div className="merge-footer">
            <input
              type="text"
              className="merge-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Merge commit message"
              disabled={busy}
            />
            <div className="history-drawer-actions">
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void onAbort()}>
                Abort merge
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !ready}
                onClick={() => void onComplete()}
              >
                {ready
                  ? "Complete merge"
                  : `Resolve ${unresolved} conflict${unresolved === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
