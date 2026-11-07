import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  getKnowledgeImpact,
  getKnowledgeSteps,
  listAllLibraryFacts,
  listKnowledgeItems,
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

function statusClass(status: string): string {
  if (status === "rejected") return "is-reject";
  if (status === "flagged") return "is-flag";
  if (status === "needs-review" || status === "unreviewed") return "is-needs";
  return "is-ok";
}

export function KnowledgeInspector({ projectId, target, onClose, onChanged }: Props) {
  const [steps, setSteps] = useState<KnowledgeStepStatus[]>([]);
  const [fact, setFact] = useState<LibraryFact | null>(null);
  const [knProjectId, setKnProjectId] = useState<string | null>(null);
  const [knTitle, setKnTitle] = useState<string | null>(null);
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
        if (target?.kind === "kn") {
          try {
            const { items } = await listKnowledgeItems();
            const hit = items.find((it) => it.knowledgeId === target.id);
            if (!cancelled) {
              setKnProjectId(hit?.id ?? null);
              setKnTitle(hit?.title ?? target.id);
            }
          } catch {
            if (!cancelled) {
              setKnProjectId(null);
              setKnTitle(target.id);
            }
          }
        } else {
          setKnProjectId(null);
          setKnTitle(null);
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
  const blockedInputs =
    step?.inputs?.filter(
      (i) =>
        i.status === "rejected" ||
        i.status === "unreviewed" ||
        i.status === "needs-review" ||
        i.status === "not_found",
    ) ?? [];

  return (
    <aside className="knowledge-inspector" aria-label="Knowledge inspector">
      <div className="knowledge-inspector-head">
        <strong>
          {target.kind === "fact"
            ? "Fact"
            : target.kind === "kn"
              ? "Knowledge item"
              : `Step · ${target.stepId}`}
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
            <span className={`knowledge-status-chip ${statusClass(fact.status)}`}>{fact.status}</span>
            {fact.value != null ? ` · ${fact.value}${fact.unit ? ` ${fact.unit}` : ""}` : ""}
          </p>
          {fact.answer ? <blockquote className="knowledge-passage">{fact.answer}</blockquote> : null}
          {fact.rejectReason ? <p className="error-text">Rejected: {fact.rejectReason}</p> : null}
          {impactCount != null ? <p className="muted">Affects {impactCount} downstream items</p> : null}
          <div className="knowledge-inspector-actions">
            <Link
              className="btn btn-quiet"
              to={`/facts?paper=${encodeURIComponent(fact.citekey)}&fact=${encodeURIComponent(fact.id)}&status=all&type=all`}
            >
              See source
            </Link>
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
              className="btn btn-danger"
              disabled={busy || fact.status === "rejected"}
              onClick={() => {
                void (async () => {
                  const reason = window.prompt("Why are you rejecting this fact? (required)", "");
                  if (reason == null) return;
                  if (!reason.trim()) {
                    setError("A reason is required when rejecting a fact.");
                    return;
                  }
                  setBusy(true);
                  try {
                    await patchLibraryFact(fact.citekey, fact.id, {
                      status: "rejected",
                      rejectReason: reason.trim(),
                    });
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
          <p>
            <span className={`knowledge-status-chip ${statusClass(step.status)}`}>{step.status}</span>
            {step.why.length ? <span className="muted"> — {step.why.join("; ")}</span> : null}
          </p>
          {step.inputs && step.inputs.length ? (
            <ul className="knowledge-step-inputs">
              {step.inputs.map((inp) => (
                <li key={inp.id} className={`knowledge-step-input ${statusClass(inp.status)}`}>
                  <div className="knowledge-step-input-head">
                    <span className={`knowledge-status-dot ${statusClass(inp.status)}`} aria-hidden />
                    <strong>{inp.label}</strong>
                    <span className="muted">{inp.status}</span>
                  </div>
                  <div className="muted">
                    {inp.value != null
                      ? `${inp.value}${inp.unit ? ` ${inp.unit}` : ""}`
                      : inp.kind === "kn"
                        ? "knowledge item"
                        : "—"}
                    {inp.source ? ` · ${inp.source}` : ""}
                    {inp.valueChanged ? " · value changed since last review" : ""}
                  </div>
                  {inp.href ? (
                    <Link className="btn btn-quiet" to={inp.href}>
                      Open
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">This step has no fact or knowledge inputs.</p>
          )}
          {blockedInputs.length ? (
            <p className="knowledge-step-warn" role="status">
              Cannot mark reviewed until {blockedInputs.length === 1 ? "this input is" : "these inputs are"}{" "}
              checked: {blockedInputs.map((i) => i.label).join(", ")}.
            </p>
          ) : null}
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
              disabled={busy || blockedInputs.length > 0}
              title={
                blockedInputs.length
                  ? "Confirm or replace unchecked / rejected inputs first"
                  : "Mark this step reviewed"
              }
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
              Mark reviewed
            </button>
            <button
              type="button"
              className="btn btn-danger"
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
              Reject step
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
          <p>{knTitle || target.id}</p>
          <p className="muted">Open the write-up to review its steps and trail.</p>
          <div className="knowledge-inspector-actions">
            {knProjectId ? (
              <Link className="btn btn-primary" to={`/p/${encodeURIComponent(knProjectId)}?review=1`}>
                Open write-up
              </Link>
            ) : (
              <Link
                className="btn btn-primary"
                to={`/knowledge?focus=${encodeURIComponent(`kn:${target.id}`)}`}
              >
                Open in tree
              </Link>
            )}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
