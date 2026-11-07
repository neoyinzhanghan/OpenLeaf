import { useEffect, useState } from "react";
import {
  getKnowledgeImpact,
  getKnowledgeSteps,
  listAllLibraryFacts,
  patchLibraryFact,
  reviewKnowledgeStep,
  type KnowledgeStepStatus,
} from "../api/client";
import type { LibraryFact } from "../api/types";
import { wordDiff, type KnowledgeCursorTarget } from "../latex/knowledgeSupport";

type Props = {
  projectId: string;
  target: KnowledgeCursorTarget;
  onClose: () => void;
  onChanged?: () => void;
};

export function KnowledgeInspector({ projectId, target, onClose, onChanged }: Props) {
  const [steps, setSteps] = useState<KnowledgeStepStatus[]>([]);
  const [fact, setFact] = useState<LibraryFact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [impactCount, setImpactCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [{ steps: s }, facts] = await Promise.all([
          getKnowledgeSteps(projectId),
          listAllLibraryFacts().catch(() => ({ facts: [] as LibraryFact[] })),
        ]);
        if (cancelled) return;
        setSteps(s);
        if (target?.kind === "fact") {
          setFact(facts.facts.find((f) => f.key === target.key) ?? null);
          try {
            const imp = await getKnowledgeImpact(`fact:${target.key}`);
            if (!cancelled) setImpactCount(imp.flagged.length);
          } catch {
            if (!cancelled) setImpactCount(null);
          }
        } else {
          setFact(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load inspector");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, target]);

  if (!target) return null;

  const step = target.kind === "step" ? steps.find((s) => s.id === target.stepId) : null;
  const diff =
    step?.reviewedText && step.body !== step.reviewedText
      ? wordDiff(step.reviewedText, step.body)
      : null;

  return (
    <aside className="knowledge-inspector" aria-label="Knowledge inspector">
      <div className="knowledge-inspector-head">
        <strong>
          {target.kind === "fact"
            ? `Fact \\fact{${target.key}}`
            : target.kind === "kn"
              ? `Knowledge \\kn{${target.id}}`
              : `Step ${target.stepId}`}
        </strong>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
      {error ? <p className="error-text">{error}</p> : null}

      {target.kind === "fact" && fact ? (
        <div className="knowledge-inspector-body">
          <p>{fact.input}</p>
          <p className="muted">
            {fact.key} · {fact.status}
            {fact.value != null ? ` · ${fact.value}${fact.unit ? ` ${fact.unit}` : ""}` : ""}
          </p>
          {fact.answer ? <blockquote className="knowledge-passage">{fact.answer}</blockquote> : null}
          {impactCount != null ? <p className="muted">Also used by {impactCount} flagged downstream</p> : null}
          <div className="knowledge-inspector-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || fact.status === "confirmed"}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  try {
                    await patchLibraryFact(fact.citekey, fact.id, {
                      status: "confirmed",
                      confirmWithContent: true,
                    });
                    onChanged?.();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Confirm failed");
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              Confirm
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  try {
                    await patchLibraryFact(fact.citekey, fact.id, { status: "rejected" });
                    onChanged?.();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Reject failed");
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              Reject
            </button>
          </div>
        </div>
      ) : null}

      {target.kind === "step" && step ? (
        <div className="knowledge-inspector-body">
          <p className="muted">
            {step.status}
            {step.why.length ? ` — ${step.why.join("; ")}` : ""}
          </p>
          {diff ? (
            <p className="knowledge-word-diff" aria-label="Word diff since last review">
              {diff.map((d, i) => (
                <span key={`${d.type}-${i}`} className={`wd-${d.type}`}>
                  {d.text}{" "}
                </span>
              ))}
            </p>
          ) : (
            <pre className="knowledge-step-body">{step.body.slice(0, 400)}</pre>
          )}
          <div className="knowledge-inspector-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  try {
                    await reviewKnowledgeStep(projectId, { stepId: step.id, verdict: "reviewed" });
                    onChanged?.();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Review failed");
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              Review
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  try {
                    await reviewKnowledgeStep(projectId, { stepId: step.id, verdict: "rejected" });
                    onChanged?.();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Reject failed");
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              Reject
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  try {
                    await reviewKnowledgeStep(projectId, { stepId: step.id, verdict: "clear" });
                    onChanged?.();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Clear failed");
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}

      {target.kind === "kn" ? (
        <div className="knowledge-inspector-body">
          <p className="muted">Open this item from the Knowledge tree to review its steps.</p>
        </div>
      ) : null}
    </aside>
  );
}
