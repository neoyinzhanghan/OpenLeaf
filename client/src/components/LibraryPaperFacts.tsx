import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import {
  createLibraryFact,
  deleteLibraryFact,
  getLibraryFactsCapability,
  listLibraryFacts,
  patchLibraryFact,
} from "../api/client";
import type {
  FactDisplayRect,
  FactStatus,
  FactType,
  FactsCapability,
  PaperFact,
  PaperRecord,
} from "../api/types";
import type { PdfAnnotationMark, PdfHighlight } from "./PdfViewer";

const FACT_TYPES: Array<{ id: FactType; label: string; placeholder: string }> = [
  {
    id: "statement",
    label: "Statement",
    placeholder: "A claim to check against the paper…",
  },
  {
    id: "value",
    label: "Value",
    placeholder: "Named quantity to extract (e.g. AUROC on TCGA-NSCLC)…",
  },
  {
    id: "question",
    label: "Question",
    placeholder: "Ask something about this paper…",
  },
  {
    id: "tag",
    label: "Tag",
    placeholder: "Label to locate (e.g. Proposition 3.1)…",
  },
];

const STATUS_LABEL: Record<FactStatus, string> = {
  unreviewed: "Unreviewed",
  confirmed: "Confirmed",
  rejected: "Rejected",
  not_found: "Not found",
};

export type FactTagTool = "box" | "text" | null;

export type FactTagSession = {
  tool: "box" | "text";
  /** Existing fact to retag, or null while composing a new human-tagged fact. */
  factId: string | null;
};

type Props = {
  paper: PaperRecord;
  onError?: (message: string) => void;
  /** When set, select and jump to this fact once loaded. */
  focusFactId?: string | null;
  onFlash?: (flash: PdfHighlight | null) => void;
  onMarksChange?: (marks: PdfAnnotationMark[]) => void;
  selectedFactId?: string | null;
  onSelectedFactIdChange?: (id: string | null) => void;
  /** Active PDF tagging session (box or text). */
  tagSession?: FactTagSession | null;
  onTagSessionChange?: (session: FactTagSession | null) => void;
  /** Called after a successful human tag so the parent can clear flash tools. */
  onTagged?: (fact: PaperFact) => void;
  /** Imperative: apply a PDF rect as a tag (from parent PdfViewer). */
  tagRectRef?: MutableRefObject<
    ((rect: { page: number; x: number; y: number; w: number; h: number }) => Promise<void>) | null
  >;
};

function answerLabel(fact: PaperFact): string {
  if (fact.type === "tag") return "";
  if (fact.type === "statement") {
    if (fact.answer === "supported") return "Supported";
    if (fact.answer === "not_supported") return "Not supported";
  }
  return fact.answer;
}

function unionRects(rects: FactDisplayRect[]): FactDisplayRect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  const merged: FactDisplayRect = {
    page: rects[0]!.page,
    x,
    y,
    w: Math.max(1, right - x),
    h: Math.max(1, bottom - y),
  };
  const vVotes = rects.filter((r) => r.orient === "v" || r.h > r.w * 1.35).length;
  merged.orient = vVotes > rects.length / 2 || merged.h > merged.w * 1.35 ? "v" : "h";
  return merged;
}

function factMarks(facts: PaperFact[], selectedId: string | null): PdfAnnotationMark[] {
  const marks: PdfAnnotationMark[] = [];
  for (const f of facts) {
    if (!f.displayRects.length) continue;
    const byPage = new Map<number, typeof f.displayRects>();
    for (const r of f.displayRects) {
      const list = byPage.get(r.page) ?? [];
      list.push(r);
      byPage.set(r.page, list);
    }
    for (const [page, rects] of byPage) {
      const cell = unionRects(rects);
      const vertical = cell.orient === "v";
      const w = vertical ? Math.max(cell.w, 14) : Math.max(cell.w, 20);
      const h = vertical ? Math.max(cell.h, 22) : Math.max(cell.h, 10);
      marks.push({
        id: `${f.id}:p${page}`,
        kind: "highlight",
        page,
        x: cell.x,
        y: cell.y,
        w,
        h,
        color: f.id === selectedId ? "#facc15" : "#60a5fa",
        label: f.input.slice(0, 80),
        selected: f.id === selectedId,
        rects: [{ x: cell.x, y: cell.y, w, h }],
      });
    }
  }
  return marks;
}

function shortSubject(fact: PaperFact): string {
  const m = fact.input.match(/^(?:AUROC|AUC|C-index|accuracy|F1) of (.+?) on /i);
  if (m?.[1]) return m[1].trim();
  if (fact.input.length <= 80) return fact.input;
  return `${fact.input.slice(0, 78)}…`;
}

type StatusFilter = FactStatus | "" | "untagged";

export function LibraryPaperFacts({
  paper,
  onError,
  focusFactId,
  onFlash,
  onMarksChange,
  selectedFactId: controlledSelected,
  onSelectedFactIdChange,
  tagSession,
  onTagSessionChange,
  onTagged,
  tagRectRef,
}: Props) {
  const [capability, setCapability] = useState<FactsCapability | null>(null);
  const [facts, setFacts] = useState<PaperFact[]>([]);
  const [type, setType] = useState<FactType>("value");
  const [draft, setDraft] = useState("");
  const [draftAnswer, setDraftAnswer] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("unreviewed");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editInput, setEditInput] = useState("");
  const [editAnswer, setEditAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const citekeyRef = useRef(paper.citekey);
  const focusedRef = useRef<string | null>(null);
  const tagSessionRef = useRef(tagSession);
  tagSessionRef.current = tagSession;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const draftAnswerRef = useRef(draftAnswer);
  draftAnswerRef.current = draftAnswer;
  const typeRef = useRef(type);
  typeRef.current = type;

  const selectedId = controlledSelected !== undefined ? controlledSelected : localSelected;
  const setSelectedId = (id: string | null) => {
    onSelectedFactIdChange?.(id);
    if (controlledSelected === undefined) setLocalSelected(id);
  };

  const refresh = useCallback(async () => {
    const requestedFor = paper.citekey;
    try {
      const [{ capability: cap }, { facts: list }] = await Promise.all([
        getLibraryFactsCapability(paper.citekey),
        listLibraryFacts(paper.citekey),
      ]);
      if (citekeyRef.current !== requestedFor) return;
      setCapability(cap);
      setFacts(list);
    } catch (err) {
      if (citekeyRef.current !== requestedFor) return;
      onError?.(err instanceof Error ? err.message : "Could not load facts");
    }
  }, [paper.citekey, onError]);

  useEffect(() => {
    citekeyRef.current = paper.citekey;
    focusedRef.current = null;
    setCapability(null);
    setFacts([]);
    setDraft("");
    setEditingId(null);
    setSelectedId(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset selection only on paper change
  }, [paper.citekey, paper.attachment, refresh]);

  const jumpTo = useCallback(
    (fact: PaperFact) => {
      setSelectedId(fact.id);
      if (!fact.displayRects.length) {
        onFlash?.(null);
        return;
      }
      const rect = unionRects(fact.displayRects);
      const vertical = rect.orient === "v";
      onFlash?.({
        page: rect.page,
        x: Math.max(0, rect.x - (vertical ? 2 : 3)),
        y: Math.max(0, rect.y - (vertical ? 2 : 2)),
        width: vertical ? Math.max(rect.w + 4, 10) : Math.max(rect.w + 6, 28),
        height: vertical ? Math.max(rect.h + 4, 14) : Math.max(rect.h + 4, 10),
        // Always hug the table cell / quote — never paint a full-page band.
        fullWidth: false,
        fullHeight: vertical,
        label: fact.input.slice(0, 48),
        nonce: Date.now(),
      });
    },
    [onFlash],
  );

  useEffect(() => {
    onMarksChange?.(factMarks(facts, selectedId));
  }, [facts, selectedId, onMarksChange]);

  useEffect(() => {
    if (!focusFactId || !facts.length) return;
    if (focusedRef.current === focusFactId) return;
    const hit = facts.find((f) => f.id === focusFactId);
    if (!hit) return;
    focusedRef.current = focusFactId;
    jumpTo(hit);
  }, [focusFactId, facts, jumpTo]);

  const typeMeta = useMemo(
    () => FACT_TYPES.find((t) => t.id === type) ?? FACT_TYPES[0]!,
    [type],
  );

  const unavailableReason = useMemo(() => {
    if (!capability) return null;
    if (capability.ok) return null;
    return capability.reason === "no-pdf"
      ? "Facts need a PDF attached to this paper."
      : "Facts need a PDF with selectable text (a text layer).";
  }, [capability]);

  const create = async () => {
    if (!draft.trim() || unavailableReason) return;
    setBusy(true);
    try {
      const { fact } = await createLibraryFact(paper.citekey, {
        type,
        input: draft.trim(),
      });
      setDraft("");
      setDraftAnswer("");
      await refresh();
      jumpTo(fact);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Could not create fact");
    } finally {
      setBusy(false);
    }
  };

  const applyTagRect = useCallback(
    async (rect: { page: number; x: number; y: number; w: number; h: number }) => {
      const session = tagSessionRef.current;
      if (!session) return;
      setBusy(true);
      try {
        if (session.factId) {
          const { fact } = await patchLibraryFact(paper.citekey, session.factId, { rect });
          await refresh();
          onTagSessionChange?.(null);
          onTagged?.(fact);
          jumpTo(fact);
        } else {
          const input = draftRef.current.trim();
          if (!input) {
            onError?.("Enter a fact label before tagging the PDF.");
            return;
          }
          const { fact } = await createLibraryFact(paper.citekey, {
            type: typeRef.current,
            input,
            answer: draftAnswerRef.current.trim() || undefined,
            rect,
          });
          setDraft("");
          setDraftAnswer("");
          setComposeOpen(false);
          await refresh();
          onTagSessionChange?.(null);
          onTagged?.(fact);
          jumpTo(fact);
        }
      } catch (err) {
        onError?.(err instanceof Error ? err.message : "Could not tag fact");
      } finally {
        setBusy(false);
      }
    },
    [paper.citekey, refresh, onError, onTagSessionChange, onTagged, jumpTo],
  );

  useEffect(() => {
    if (!tagRectRef) return;
    tagRectRef.current = applyTagRect;
    return () => {
      tagRectRef.current = null;
    };
  }, [tagRectRef, applyTagRect]);

  const beginTag = (fact: PaperFact | null, tool: "box" | "text") => {
    if (fact) {
      setSelectedId(fact.id);
      setStatusFilter("untagged");
      onTagSessionChange?.({ tool, factId: fact.id });
    } else {
      setComposeOpen(true);
      onTagSessionChange?.({ tool, factId: null });
    }
  };

  const beginEdit = (fact: PaperFact) => {
    setEditingId(fact.id);
    setEditInput(fact.input);
    setEditAnswer(fact.answer);
    jumpTo(fact);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setBusy(true);
    try {
      const patch: { input?: string; answer?: string } = {};
      const prev = facts.find((f) => f.id === editingId);
      if (!prev) return;
      if (editInput.trim() !== prev.input) patch.input = editInput.trim();
      if (prev.type !== "tag" && editAnswer !== prev.answer) patch.answer = editAnswer;
      if (Object.keys(patch).length) {
        const { fact } = await patchLibraryFact(paper.citekey, editingId, patch);
        setEditingId(null);
        await refresh();
        jumpTo(fact);
      } else {
        setEditingId(null);
      }
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Could not update fact");
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (fact: PaperFact, nextStatus: "confirmed" | "rejected" | "unreviewed") => {
    setBusy(true);
    const prev = fact.status;
    if (statusFilter === "unreviewed" && nextStatus !== "unreviewed") {
      const queue = facts.filter((f) => f.status === "unreviewed");
      const idx = queue.findIndex((f) => f.id === fact.id);
      const remaining = queue.filter((f) => f.id !== fact.id);
      const nextInQueue = remaining[Math.min(Math.max(idx, 0), Math.max(remaining.length - 1, 0))];
      if (nextInQueue) jumpTo(nextInQueue);
    }
    setFacts((list) => list.map((f) => (f.id === fact.id ? { ...f, status: nextStatus } : f)));
    try {
      await patchLibraryFact(paper.citekey, fact.id, { status: nextStatus });
    } catch (err) {
      setFacts((list) => list.map((f) => (f.id === fact.id ? { ...f, status: prev } : f)));
      onError?.(err instanceof Error ? err.message : "Could not update status");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (fact: PaperFact) => {
    setBusy(true);
    try {
      await deleteLibraryFact(paper.citekey, fact.id);
      if (selectedId === fact.id) setSelectedId(null);
      if (editingId === fact.id) setEditingId(null);
      await refresh();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Could not delete fact");
    } finally {
      setBusy(false);
    }
  };

  const visibleFacts = useMemo(() => {
    if (statusFilter === "untagged") return facts.filter((f) => !f.highlights.length);
    if (!statusFilter) return facts;
    return facts.filter((f) => f.status === statusFilter);
  }, [facts, statusFilter]);

  const unreviewedCount = useMemo(
    () => facts.filter((f) => f.status === "unreviewed").length,
    [facts],
  );
  const untaggedCount = useMemo(
    () => facts.filter((f) => !f.highlights.length).length,
    [facts],
  );

  if (unavailableReason) {
    return (
      <div className="library-facts">
        <p className="muted library-hint">{unavailableReason}</p>
      </div>
    );
  }

  if (!capability) {
    return (
      <div className="library-facts">
        <p className="muted">Checking PDF text…</p>
      </div>
    );
  }

  return (
    <div className="library-facts">
      <div className="library-facts-paper-head">
        <div className="library-facts-status-tabs" role="tablist" aria-label="Fact status">
          {(
            [
              ["unreviewed", `Unreviewed (${unreviewedCount})`],
              ["untagged", `Untagged (${untaggedCount})`],
              ["", "All"],
              ["confirmed", "Confirmed"],
              ["rejected", "Rejected"],
            ] as Array<[StatusFilter, string]>
          ).map(([s, label]) => (
            <button
              key={s || "all"}
              type="button"
              role="tab"
              aria-selected={statusFilter === s}
              className={`btn btn-ghost library-facts-status-tab${statusFilter === s ? " is-active" : ""}`}
              onClick={() => setStatusFilter(s)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`btn btn-ghost${composeOpen ? " is-active" : ""}`}
          onClick={() => {
            setComposeOpen((o) => !o);
            if (composeOpen) onTagSessionChange?.(null);
          }}
        >
          {composeOpen ? "Hide add" : "Add fact"}
        </button>
      </div>

      {tagSession ? (
        <div className="library-facts-tag-banner" role="status">
          <span>
            {tagSession.factId
              ? `Tagging on PDF (${tagSession.tool === "text" ? "text select" : "box"}) — select the evidence, then it auto-confirms.`
              : `New fact from ${tagSession.tool === "text" ? "text" : "box"} — enter a label, then select on the PDF.`}
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => onTagSessionChange?.(null)}>
            Cancel
          </button>
        </div>
      ) : null}

      {composeOpen ? (
        <div className="library-facts-compose">
          <div className="library-facts-types" role="group" aria-label="Fact type">
            {FACT_TYPES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`btn btn-ghost library-ann-tool${type === t.id ? " is-active" : ""}`}
                aria-pressed={type === t.id}
                onClick={() => setType(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <textarea
            className="library-notes"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={typeMeta.placeholder}
            disabled={busy}
          />
          {type !== "tag" ? (
            <input
              className="library-ann-quote"
              type="text"
              value={draftAnswer}
              onChange={(e) => setDraftAnswer(e.target.value)}
              placeholder="Answer / value (optional for AI; required-ish for manual tag)"
              disabled={busy}
            />
          ) : null}
          <div className="library-pdf-pin-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !draft.trim() || Boolean(tagSession)}
              onClick={() => void create()}
            >
              {busy ? "Retrieving…" : "Add via AI"}
            </button>
            <button
              type="button"
              className={`btn btn-ghost${tagSession?.tool === "box" && !tagSession.factId ? " is-active" : ""}`}
              disabled={busy || !draft.trim()}
              onClick={() => beginTag(null, "box")}
              title="Draw a box on the PDF to place this fact"
            >
              Tag with box
            </button>
            <button
              type="button"
              className={`btn btn-ghost${tagSession?.tool === "text" && !tagSession.factId ? " is-active" : ""}`}
              disabled={busy || !draft.trim()}
              onClick={() => beginTag(null, "text")}
              title="Select text on the PDF to place this fact"
            >
              Tag with text
            </button>
          </div>
        </div>
      ) : null}

      <ul className="library-annotation-list library-facts-list">
        {!visibleFacts.length ? (
          <li className="muted">
            {!facts.length
              ? "No facts yet — Add fact to extract from the PDF, or tag one manually."
              : statusFilter === "unreviewed"
                ? "No unreviewed facts on this paper."
                : statusFilter === "untagged"
                  ? "No untagged facts — every fact still has a PDF anchor."
                  : "No facts in this filter."}
          </li>
        ) : null}
        {visibleFacts.map((f) => {
          const editing = editingId === f.id;
          const ans = answerLabel(f);
          const page = f.highlights[0]?.page;
          const untagged = !f.highlights.length;
          const taggingThis = tagSession?.factId === f.id;
          return (
            <li
              key={f.id}
              className={`library-annotation-item library-fact-item${selectedId === f.id ? " is-selected" : ""}${untagged ? " is-untagged" : ""}${taggingThis ? " is-tagging" : ""}`}
            >
              {editing ? (
                <div className="library-fact-edit">
                  <textarea
                    className="library-notes"
                    rows={2}
                    value={editInput}
                    onChange={(e) => setEditInput(e.target.value)}
                  />
                  {f.type !== "tag" ? (
                    <input
                      className="library-ann-quote"
                      type="text"
                      value={editAnswer}
                      onChange={(e) => setEditAnswer(e.target.value)}
                      placeholder="Answer"
                    />
                  ) : null}
                  <div className="library-pdf-pin-actions">
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void saveEdit()}>
                      Save
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button type="button" className="library-annotation-jump" onClick={() => jumpTo(f)}>
                    <span className="library-facts-card-answer library-facts-inline-answer">{ans || "—"}</span>
                    <span className={`library-fact-status is-${f.status}`}>{STATUS_LABEL[f.status]}</span>
                    {untagged ? <span className="library-fact-status is-untagged">Untagged</span> : null}
                    {page != null ? <span className="library-annotation-page">p.{page}</span> : null}
                    <span className="library-annotation-body">
                      <strong className="library-facts-subject">{shortSubject(f)}</strong>
                      {f.highlights[0]?.quote ? (
                        <>
                          <br />
                          <em className="muted">“{f.highlights[0].quote.slice(0, 120)}”</em>
                        </>
                      ) : (
                        <>
                          <br />
                          <em className="muted">No PDF anchor — tag with box or text.</em>
                        </>
                      )}
                    </span>
                  </button>
                  <div className="library-fact-actions">
                    {untagged || taggingThis ? (
                      <>
                        <button
                          type="button"
                          className={`btn btn-primary${taggingThis && tagSession?.tool === "box" ? " is-active" : ""}`}
                          disabled={busy}
                          title="Draw a box on the PDF"
                          onClick={() => beginTag(f, "box")}
                        >
                          Box
                        </button>
                        <button
                          type="button"
                          className={`btn btn-ghost${taggingThis && tagSession?.tool === "text" ? " is-active" : ""}`}
                          disabled={busy}
                          title="Select text on the PDF"
                          onClick={() => beginTag(f, "text")}
                        >
                          Text
                        </button>
                      </>
                    ) : null}
                    {f.status !== "not_found" ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy || f.status === "confirmed"}
                          title="Confirm"
                          onClick={() => void setStatus(f, "confirmed")}
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={busy || f.status === "rejected"}
                          title="Reject"
                          onClick={() => void setStatus(f, "rejected")}
                        >
                          Reject
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      title="Edit"
                      onClick={() => beginEdit(f)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      title="Delete fact"
                      aria-label="Delete fact"
                      onClick={() => void remove(f)}
                    >
                      ×
                    </button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
