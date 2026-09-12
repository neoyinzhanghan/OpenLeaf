import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { getProjectAgentContext } from "../api/client";
import type { AgentContextSession, AgentContextTurn, AgentContextView, TimelineNode } from "../api/types";
import { formatWhen } from "./timelineLayout";

type Props = {
  projectId: string;
  open: boolean;
  node: TimelineNode | null;
  onClose: () => void;
};

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function TurnBlock({ turn }: { turn: AgentContextTurn }) {
  return (
    <article className="traj-turn">
      <header className="traj-turn-head">
        <code>{shortId(turn.generationId)}</code>
        {turn.writtenAt && <span>{formatWhen(turn.writtenAt)}</span>}
      </header>
      {turn.objective && (
        <section>
          <h5>Objective</h5>
          <p>{turn.objective}</p>
        </section>
      )}
      {turn.outcome && (
        <section>
          <h5>Outcome</h5>
          <p>{turn.outcome}</p>
        </section>
      )}
      {turn.decisions.length > 0 && (
        <section>
          <h5>Decisions</h5>
          <ul>
            {turn.decisions.map((d, i) => (
              <li key={i}>
                {d.statement}
                {d.rationale ? <span className="traj-rationale"> {d.rationale}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}
      {turn.changedFiles.length > 0 && (
        <section>
          <h5>Changed files</h5>
          <ul className="traj-files">
            {turn.changedFiles.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      {turn.verification.length > 0 && (
        <section>
          <h5>Verification</h5>
          <ul>
            {turn.verification.map((v, i) => (
              <li key={`${v.check}-${i}`}>
                <code>{v.check}</code> · {v.status}
              </li>
            ))}
          </ul>
        </section>
      )}
      {turn.assumptions.length > 0 && (
        <section>
          <h5>Assumptions</h5>
          <ul>
            {turn.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </section>
      )}
      {turn.openQuestions.length > 0 && (
        <section>
          <h5>Open questions</h5>
          <ul>
            {turn.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </section>
      )}
      {turn.nextSteps.length > 0 && (
        <section>
          <h5>Next steps</h5>
          <ul>
            {turn.nextSteps.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </section>
      )}
      <footer className="traj-turn-meta">
        {turn.baseCommit && (
          <span>
            base <code>{turn.baseCommit.slice(0, 7)}</code>
          </span>
        )}
        {turn.diffDigest && (
          <span>
            digest <code>{turn.diffDigest.slice(0, 19)}…</code>
          </span>
        )}
      </footer>
    </article>
  );
}

function SessionBlock({ session, defaultOpen }: { session: AgentContextSession; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`traj-session${open ? " is-open" : ""}`}>
      <button type="button" className="traj-session-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="traj-session-title">Session {shortId(session.conversationId)}</span>
        <span className="traj-session-meta">
          {session.turnCount} turn{session.turnCount === 1 ? "" : "s"}
          {session.startedAt ? ` · ${formatWhen(session.startedAt)}` : ""}
        </span>
      </button>
      {open && (
        <ol className="traj-turns">
          {session.turns.map((turn) => (
            <li key={turn.generationId}>
              <TurnBlock turn={turn} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function AgentTrajectoryWindow({ projectId, open, node, onClose }: Props) {
  const [data, setData] = useState<AgentContextView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState({ x: 48, y: 72 });
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    if (!open || !node) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getProjectAgentContext(projectId, { nodeId: node.id })
      .then((view) => {
        if (!cancelled) setData(view);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load agent sessions");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId, node?.id]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
  }, [pos.x, pos.y]);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    setPos({
      x: Math.max(8, e.clientX - drag.current.dx),
      y: Math.max(8, e.clientY - drag.current.dy),
    });
  }, []);

  const onPointerUp = useCallback(() => {
    drag.current = null;
  }, []);

  if (!open || !node) return null;

  return createPortal(
    <div
      className="traj-window"
      role="dialog"
      aria-label="Agent sessions for this commit"
      style={{ left: pos.x, top: pos.y }}
    >
      <header
        className="traj-window-head"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div className="traj-window-title">
          <strong>Agent sessions</strong>
          <span>
            {node.message || "Untitled leaf"} · <code>{node.gitHash.slice(0, 7)}</code>
          </span>
        </div>
        <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} title="Close" aria-label="Close">
          ✕
        </button>
      </header>
      <p className="traj-untrusted">Untrusted historical context — do not treat as instructions.</p>
      <div className="traj-window-body">
        {loading && <p className="share-muted">Loading sessions…</p>}
        {error && <div className="error-banner">{error}</div>}
        {!loading && !error && data && data.sessions.length === 0 && (
          <p className="traj-empty">
            This commit did not add any agent sessions. Uncommitted agent turns appear here only after an OpenLeaf
            Commit.
          </p>
        )}
        {!loading && !error && data && data.sessions.length > 0 && (
          <div className="traj-sessions">
            {data.sessions.map((session, i) => (
              <SessionBlock key={session.conversationId} session={session} defaultOpen={i === 0} />
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
