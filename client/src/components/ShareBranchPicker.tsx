import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getProjectTimeline } from "../api/client";
import type { TimelineBranch, TimelineNode, TimelineView } from "../api/types";
import { TimelineGraph } from "./TimelineGraph";
import { formatWhen } from "./timelineLayout";

export type ShareBranchChoice =
  | {
      mode: "continue";
      branchId: string;
      branchName: string;
      sacred: boolean;
      tipNodeId: string;
      allowMainShare: boolean;
    }
  | {
      mode: "fork";
      fromNodeId: string;
      fromBranchName: string;
      fromMessage: string;
      isTip: boolean;
      forkName: string;
    };

type Props = {
  projectId: string;
  value: ShareBranchChoice | null;
  onChange: (next: ShareBranchChoice | null) => void;
  disabled?: boolean;
};

type PromptState =
  | {
      kind: "tip";
      node: TimelineNode;
      branch: TimelineBranch;
      forkName: string;
      allowMainShare: boolean;
      intent: "continue" | "fork";
    }
  | {
      kind: "history";
      node: TimelineNode;
      branch: TimelineBranch;
      forkName: string;
    };

export function ShareBranchPicker({ projectId, value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<TimelineView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [recenterToken, setRecenterToken] = useState(0);

  const close = useCallback(() => {
    setOpen(false);
    setPrompt(null);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setView(await getProjectTimeline(projectId));
      setRecenterToken((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load timeline");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (prompt) setPrompt(null);
        else close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, prompt, close]);

  const openNode = (node: TimelineNode, branch: TimelineBranch) => {
    const isTip = branch.headNodeId === node.id;
    if (isTip) {
      setPrompt({
        kind: "tip",
        node,
        branch,
        forkName: "",
        allowMainShare: false,
        intent: "continue",
      });
    } else {
      setPrompt({
        kind: "history",
        node,
        branch,
        forkName: "",
      });
    }
  };

  const confirmPrompt = () => {
    if (!prompt) return;
    if (prompt.kind === "tip") {
      if (prompt.intent === "continue") {
        if (prompt.branch.sacred && !prompt.allowMainShare) {
          setError("Confirm that you understand sharing the sacred main tip");
          return;
        }
        onChange({
          mode: "continue",
          branchId: prompt.branch.id,
          branchName: prompt.branch.name,
          sacred: Boolean(prompt.branch.sacred),
          tipNodeId: prompt.node.id,
          allowMainShare: Boolean(prompt.branch.sacred && prompt.allowMainShare),
        });
        setPrompt(null);
        setOpen(false);
        setError(null);
        return;
      }
      const name = prompt.forkName.trim();
      if (!/^[a-zA-Z0-9._/-]{1,64}$/.test(name) || name === "main") {
        setError("Branch name: 1–64 chars (letters, numbers, . _ / -), not “main”");
        return;
      }
      onChange({
        mode: "fork",
        fromNodeId: prompt.node.id,
        fromBranchName: prompt.branch.name,
        fromMessage: prompt.node.message,
        isTip: true,
        forkName: name,
      });
      setPrompt(null);
      setOpen(false);
      setError(null);
      return;
    }

    const name = prompt.forkName.trim();
    if (!/^[a-zA-Z0-9._/-]{1,64}$/.test(name) || name === "main") {
      setError("Branch name: 1–64 chars (letters, numbers, . _ / -), not “main”");
      return;
    }
    onChange({
      mode: "fork",
      fromNodeId: prompt.node.id,
      fromBranchName: prompt.branch.name,
      fromMessage: prompt.node.message,
      isTip: false,
      forkName: name,
    });
    setPrompt(null);
    setOpen(false);
    setError(null);
  };

  const summary = !value
    ? "Select a leaf on the timeline…"
    : value.mode === "continue"
      ? `Continue on ${value.branchName}${value.sacred ? " (sacred)" : ""}`
      : `Fork “${value.forkName}” from ${value.fromBranchName}${value.isTip ? " tip" : " leaf"}`;

  const selectedId =
    prompt?.node.id ??
    (value?.mode === "continue" ? value.tipNodeId : value?.mode === "fork" ? value.fromNodeId : null);

  const drawer =
    open &&
    createPortal(
      <aside className="history-drawer timeline-drawer share-pick-drawer" role="dialog" aria-modal="true" aria-label="Pick share leaf from timeline">
        <div className="history-drawer-head">
          <strong>
            Pick a leaf to share
            {view ? ` · ${view.nodes.length} leaf${view.nodes.length === 1 ? "" : "ves"}` : ""}
          </strong>
          <div className="history-drawer-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setRecenterToken((n) => n + 1)}
              disabled={loading}
            >
              Recenter
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void refresh()} disabled={loading}>
              Refresh
            </button>
            <button type="button" className="btn btn-ghost" onClick={close}>
              Close
            </button>
          </div>
        </div>

        <p className="history-hint timeline-hint">
          Same timeline as the viewer — drag to pan, click a leaf to choose it. Tip → continue or fork. Past leaf →
          fork required.
        </p>

        {error && <div className="error-banner share-error">{error}</div>}

        <TimelineGraph
          view={view}
          loading={loading}
          selectedId={selectedId}
          recenterToken={recenterToken}
          emptyLabel="No leaves yet — commit on the timeline first."
          onNodeClick={(node, branch) => openNode(node, branch)}
        >
          {prompt && (
            <div className="share-pick-prompt tl-hover-dock" role="alertdialog" aria-modal="true">
              <div className="share-pick-prompt-body">
                <div className="share-pick-leaf-info">
                  <div className="share-pick-card-kicker">
                    <span>{prompt.branch.name}</span>
                    {prompt.kind === "tip" ? (
                      <span className="tl-chip">tip</span>
                    ) : (
                      <span className="tl-chip muted">past</span>
                    )}
                    {prompt.node.legacy && <span className="tl-chip muted">legacy</span>}
                    {prompt.branch.sacred && <span className="tl-chip sacred">sacred</span>}
                  </div>
                  <div className="share-pick-card-title">{prompt.node.message}</div>
                  <div className="share-pick-card-meta">
                    <code>{prompt.node.gitHash.slice(0, 7)}</code>
                    <span>{prompt.node.author}</span>
                    <span>{formatWhen(prompt.node.createdAt)}</span>
                  </div>
                </div>

                {prompt.kind === "tip" ? (
                  <>
                    <div className="share-pick-intent">
                      <label className={`share-access-option${prompt.intent === "continue" ? " is-selected" : ""}`}>
                        <input
                          type="radio"
                          name="share-pick-intent"
                          checked={prompt.intent === "continue"}
                          onChange={() => setPrompt({ ...prompt, intent: "continue" })}
                        />
                        <span>
                          <strong>Continue on {prompt.branch.name}</strong>
                          <span className="share-muted"> Guests share this branch’s live tip.</span>
                        </span>
                      </label>
                      <label className={`share-access-option${prompt.intent === "fork" ? " is-selected" : ""}`}>
                        <input
                          type="radio"
                          name="share-pick-intent"
                          checked={prompt.intent === "fork"}
                          onChange={() => setPrompt({ ...prompt, intent: "fork" })}
                        />
                        <span>
                          <strong>Fork a new branch from this tip</strong>
                          <span className="share-muted"> Created when the share session starts.</span>
                        </span>
                      </label>
                    </div>
                    {prompt.intent === "fork" && (
                      <label className="share-field">
                        <span className="share-field-label">New branch name</span>
                        <input
                          type="text"
                          value={prompt.forkName}
                          placeholder="e.g. review-alice"
                          onChange={(e) => setPrompt({ ...prompt, forkName: e.target.value })}
                          autoFocus
                        />
                      </label>
                    )}
                    {prompt.intent === "continue" && prompt.branch.sacred && (
                      <label className="share-check">
                        <input
                          type="checkbox"
                          checked={prompt.allowMainShare}
                          onChange={(e) => setPrompt({ ...prompt, allowMainShare: e.target.checked })}
                        />
                        <span>
                          <strong>I understand this shares the sacred main tip</strong>
                        </span>
                      </label>
                    )}
                  </>
                ) : (
                  <>
                    <p className="share-muted">
                      Working from a non-tip requires a new branch — guests will land on that fork’s tip.
                    </p>
                    <label className="share-field">
                      <span className="share-field-label">New branch name</span>
                      <input
                        type="text"
                        value={prompt.forkName}
                        placeholder="e.g. review-alice"
                        onChange={(e) => setPrompt({ ...prompt, forkName: e.target.value })}
                        autoFocus
                      />
                    </label>
                  </>
                )}

                <div className="share-pick-prompt-actions">
                  <button type="button" className="btn btn-ghost" onClick={() => setPrompt(null)}>
                    Back
                  </button>
                  <button type="button" className="btn btn-primary" onClick={confirmPrompt}>
                    Use this leaf
                  </button>
                </div>
              </div>
            </div>
          )}
        </TimelineGraph>
      </aside>,
      document.body,
    );

  return (
    <div className={`share-branch-picker${open ? " is-open" : ""}`}>
      <button
        type="button"
        className={`share-branch-trigger${value ? " has-value" : ""}`}
        disabled={disabled}
        aria-expanded={open}
        onClick={() => {
          if (open) close();
          else {
            setOpen(true);
            setPrompt(null);
            setError(null);
          }
        }}
      >
        <span className="share-branch-trigger-label">{summary}</span>
        <span className="share-branch-trigger-caret" aria-hidden>
          {open ? "Close" : "Open"}
        </span>
      </button>

      {value && (
        <button
          type="button"
          className="btn btn-ghost share-branch-clear"
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          Clear
        </button>
      )}

      {drawer}
    </div>
  );
}
