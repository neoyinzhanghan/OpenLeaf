import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createLibraryAnnotation,
  deleteLibraryAnnotation,
  libraryPdfUrl,
  listLibraryAnnotations,
  patchLibraryAnnotation,
} from "../api/client";
import type { PaperAnnotation, PaperRecord } from "../api/types";
import {
  previewPdfReplace,
  uploadPaperPdf,
  type PdfReplacePreview,
} from "../lib/libraryPdfUpload";
import {
  PdfViewer,
  type PdfAnnotationMark,
  type PdfAreaRect,
  type PdfHighlight,
  type PdfInteractionMode,
  type PdfTextSelection,
} from "./PdfViewer";
import { LibraryPaperFacts, type FactTagSession } from "./LibraryPaperFacts";

const COLORS = [
  "#facc15",
  "#4ade80",
  "#60a5fa",
  "#f472b6",
  "#fb923c",
  "#a78bfa",
  "#94a3b8",
] as const;

type Tool = "select" | "highlight" | "underline" | "area" | "pin" | "note";

type PendingGeom = {
  kind: "highlight" | "underline" | "area" | "pin";
  page: number;
  x: number;
  y: number;
  w?: number;
  h?: number;
};

type Props = {
  paper: PaperRecord;
  /** Bumps when the parent attaches/replaces the PDF (cache-bust viewer URL). */
  pdfRevision?: number;
  onError?: (message: string) => void;
  onNotice?: (message: string) => void;
  /** Refresh parent paper list after PDF attach/replace. */
  onPaperChange?: (paper: PaperRecord) => void;
  /** Open the Facts pane and jump to this fact id (from the library Facts view). */
  focusFactId?: string | null;
  /** Prefer starting on the facts pane when focusing a fact. */
  initialPane?: "annotate" | "facts";
};

function kindLabel(kind: PaperAnnotation["kind"]): string {
  switch (kind) {
    case "highlight":
      return "Highlight";
    case "underline":
      return "Underline";
    case "area":
      return "Area";
    case "pin":
      return "Pin";
    default:
      return "Note";
  }
}

function toMarks(
  list: PaperAnnotation[],
  selectedId: string | null,
): PdfAnnotationMark[] {
  return list
    .filter((a) => a.page != null && a.x != null && a.y != null)
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      page: a.page!,
      x: a.x!,
      y: a.y!,
      w: a.w,
      h: a.h,
      color: a.color,
      label: (a.body || a.quote || kindLabel(a.kind)).slice(0, 80),
      selected: a.id === selectedId,
      rects: a.rects,
    }));
}

export function LibraryPdfNotes({
  paper,
  pdfRevision = 0,
  onError,
  onNotice,
  onPaperChange,
  focusFactId,
  initialPane,
}: Props) {
  const [pane, setPane] = useState<"annotate" | "facts">(initialPane ?? "annotate");
  const [annotations, setAnnotations] = useState<PaperAnnotation[]>([]);
  const [flash, setFlash] = useState<PdfHighlight | null>(null);
  const [tool, setTool] = useState<Tool>("highlight");
  const [color, setColor] = useState<string>(COLORS[0]);
  const [draft, setDraft] = useState("");
  const [quote, setQuote] = useState("");
  const [pending, setPending] = useState<PendingGeom | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(Boolean(paper.attachment));
  const [visiblePage, setVisiblePage] = useState(1);
  const [pageFilter, setPageFilter] = useState<"all" | "page">("all");
  const [factMarks, setFactMarks] = useState<PdfAnnotationMark[]>([]);
  const [selectedFactId, setSelectedFactId] = useState<string | null>(null);
  const [pdfBust, setPdfBust] = useState(() => Date.now());
  const [replacePrompt, setReplacePrompt] = useState<PdfReplacePreview | null>(null);
  const [tagSession, setTagSession] = useState<FactTagSession | null>(null);
  const tagRectRef = useRef<
    ((rect: { page: number; x: number; y: number; w: number; h: number }) => Promise<void>) | null
  >(null);

  // Guards against a stale in-flight refresh() for a previously-viewed paper
  // resolving after the user has already switched to another paper and
  // clobbering the newer paper's annotation list (mirrors LibraryPanel's
  // pdfHint effect guard).
  const citekeyRef = useRef(paper.citekey);

  const refresh = useCallback(async () => {
    const requestedFor = paper.citekey;
    try {
      const { annotations: list } = await listLibraryAnnotations(paper.citekey);
      if (citekeyRef.current !== requestedFor) return;
      setAnnotations(list);
    } catch (err) {
      if (citekeyRef.current !== requestedFor) return;
      onError?.(err instanceof Error ? err.message : "Could not load annotations");
    }
  }, [paper.citekey, onError]);

  useEffect(() => {
    citekeyRef.current = paper.citekey;
    void refresh();
    setPdfOpen(Boolean(paper.attachment));
    setPending(null);
    setEditingId(null);
    setDraft("");
    setQuote("");
    setFlash(null);
    setVisiblePage(1);
    setFactMarks([]);
    setSelectedFactId(null);
    setPane(focusFactId || initialPane === "facts" ? "facts" : "annotate");
  }, [paper.citekey, paper.attachment, refresh, focusFactId, initialPane]);

  useEffect(() => {
    if (focusFactId) {
      setPane("facts");
      setPdfOpen(true);
    }
  }, [focusFactId]);

  const editing = useMemo(
    () => (editingId ? annotations.find((a) => a.id === editingId) ?? null : null),
    [annotations, editingId],
  );

  useEffect(() => {
    if (!editing) return;
    setDraft(editing.body);
    setQuote(editing.quote ?? "");
    if (editing.color) setColor(editing.color);
  }, [editing]);

  const annotationMarks = useMemo(
    () => toMarks(annotations, editingId),
    [annotations, editingId],
  );
  const marks = pane === "facts" ? factMarks : annotationMarks;

  const filtered = useMemo(() => {
    if (pageFilter === "all") return annotations;
    return annotations.filter((a) => a.page == null || a.page === visiblePage);
  }, [annotations, pageFilter, visiblePage]);

  const interactionMode: PdfInteractionMode =
    pane === "facts"
      ? tagSession?.tool === "text"
        ? "text"
        : tagSession?.tool === "box"
          ? "area"
          : "sync"
      : tool === "select" || tool === "note"
        ? "sync"
        : tool;

  useEffect(() => {
    if (pdfRevision > 0) {
      setPdfBust(Date.now());
      setPdfOpen(Boolean(paper.attachment));
    }
  }, [pdfRevision, paper.attachment]);

  const doAttachPdf = async (file: File, replace: boolean) => {
    setBusy(true);
    try {
      const result = await uploadPaperPdf(paper.citekey, file, replace);
      setPdfBust(Date.now());
      setPdfOpen(true);
      setPane("facts");
      setTagSession(null);
      onPaperChange?.(result.paper);
      if (result.replaced) {
        onNotice?.(
          `PDF replaced — ${result.factsUntagged} fact${result.factsUntagged === 1 ? "" : "s"} untagged (status kept).`,
        );
      } else {
        onNotice?.("PDF attached.");
      }
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "PDF upload failed");
    } finally {
      setBusy(false);
      setReplacePrompt(null);
    }
  };

  const onPickPdfFile = async (file: File | undefined | null) => {
    if (!file) return;
    if (!paper.attachment) {
      await doAttachPdf(file, false);
      return;
    }
    setReplacePrompt(await previewPdfReplace(paper.citekey, file));
  };

  const onFactAreaSelect = (rect: PdfAreaRect) => {
    if (pane !== "facts" || !tagSession) return;
    void tagRectRef.current?.(rect);
  };

  const onFactTextSelect = (sel: PdfTextSelection) => {
    if (pane !== "facts" || !tagSession) return;
    void tagRectRef.current?.({ page: sel.page, x: sel.x, y: sel.y, w: sel.w, h: sel.h });
  };

  const resetComposer = () => {
    setPending(null);
    setEditingId(null);
    setDraft("");
    setQuote("");
  };

  const jumpTo = (a: PaperAnnotation) => {
    if (a.page == null || a.x == null || a.y == null) return;
    setPdfOpen(true);
    setFlash({
      page: a.page,
      x: a.x,
      y: a.y,
      width: a.w ?? 160,
      height: a.h ?? 18,
      fullWidth: false,
      label: (a.body || a.quote || kindLabel(a.kind)).slice(0, 48),
      nonce: Date.now(),
    });
  };

  const beginEdit = (a: PaperAnnotation) => {
    setEditingId(a.id);
    setPending(null);
    setDraft(a.body);
    setQuote(a.quote ?? "");
    if (a.color) setColor(a.color);
    jumpTo(a);
  };

  const saveCreate = async () => {
    if (tool === "note") {
      if (!draft.trim() && !quote.trim()) return;
      setBusy(true);
      try {
        await createLibraryAnnotation(paper.citekey, {
          kind: "note",
          body: draft.trim(),
          quote: quote.trim() || undefined,
          color,
          page: visiblePage > 0 ? visiblePage : undefined,
        });
        resetComposer();
        await refresh();
      } catch (err) {
        onError?.(err instanceof Error ? err.message : "Could not save note");
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!pending) return;
    if (pending.kind === "pin" && !draft.trim()) return;

    setBusy(true);
    try {
      await createLibraryAnnotation(paper.citekey, {
        kind: pending.kind,
        body: draft.trim(),
        quote: quote.trim() || undefined,
        color,
        page: pending.page,
        x: pending.x,
        y: pending.y,
        w: pending.w,
        h: pending.h,
        rects:
          pending.w != null && pending.h != null
            ? [{ x: pending.x, y: pending.y, w: pending.w, h: pending.h }]
            : undefined,
      });
      resetComposer();
      await refresh();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Could not save annotation");
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setBusy(true);
    try {
      await patchLibraryAnnotation(paper.citekey, editingId, {
        body: draft.trim(),
        quote: quote.trim(),
        color,
      });
      resetComposer();
      await refresh();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Could not update annotation");
    } finally {
      setBusy(false);
    }
  };

  const onAreaSelect = (rect: PdfAreaRect) => {
    if (tool !== "highlight" && tool !== "underline" && tool !== "area") return;
    setEditingId(null);
    setDraft("");
    setQuote("");
    setPending({
      kind: tool,
      page: rect.page,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
    });
    setFlash({
      page: rect.page,
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: rect.h,
      fullWidth: false,
      nonce: Date.now(),
    });
  };

  const onPinAt = (page: number, x: number, y: number) => {
    if (tool !== "pin") return;
    setEditingId(null);
    setDraft("");
    setQuote("");
    setPending({ kind: "pin", page, x, y, w: 14, h: 14 });
    setFlash({ page, x, y, width: 14, height: 14, fullWidth: false, nonce: Date.now() });
  };

  const replaceDialog = replacePrompt ? (
    <div className="library-pdf-replace-dialog" role="alertdialog" aria-modal="true">
      <div className="library-pdf-replace-card">
        <h3>Replace PDF?</h3>
        <p>
          This paper already has a PDF. Replacing it will <strong>untag</strong>{" "}
          {replacePrompt.taggedFactCount} fact
          {replacePrompt.taggedFactCount === 1 ? "" : "s"} that currently point into the PDF
          {replacePrompt.totalFacts ? ` (${replacePrompt.totalFacts} total)` : ""}.
        </p>
        <p className="muted">
          Untagged facts keep their answers and approval status (confirmed / unreviewed / rejected).
          Only the PDF anchors are cleared — you can retag them afterward.
        </p>
        <div className="library-pdf-pin-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void doAttachPdf(replacePrompt.file, true)}
          >
            {busy ? "Replacing…" : "Replace PDF"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => setReplacePrompt(null)}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  ) : null;

  if (!paper.attachment) {
    return (
      <div className="library-pdf-notes">
        {replaceDialog}
        <div className="library-pdf-notes-toolbar">
          <div className="library-ann-tools" role="tablist" aria-label="PDF pane">
            <button
              type="button"
              role="tab"
              className={`btn btn-ghost library-ann-tool${pane === "annotate" ? " is-active" : ""}`}
              aria-selected={pane === "annotate"}
              onClick={() => setPane("annotate")}
            >
              Highlights
            </button>
            <button
              type="button"
              role="tab"
              className={`btn btn-ghost library-ann-tool${pane === "facts" ? " is-active" : ""}`}
              aria-selected={pane === "facts"}
              onClick={() => setPane("facts")}
            >
              Facts
            </button>
          </div>
        </div>
        <div className="library-pdf-drop-empty">
          <p className="muted library-hint">
            No PDF attached. Drop a PDF anywhere on this paper column, or choose a file.
          </p>
          <label className="btn btn-ghost library-pdf-file-label">
            Choose PDF
            <input
              type="file"
              accept="application/pdf,.pdf"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                void onPickPdfFile(f);
              }}
            />
          </label>
        </div>
        {pane === "facts" ? <LibraryPaperFacts paper={paper} onError={onError} /> : null}
      </div>
    );
  }

  const pdfUrl = libraryPdfUrl(paper.citekey, pdfBust);
  const composing = Boolean(pending) || tool === "note" || Boolean(editing);
  const canSaveCreate =
    tool === "note"
      ? Boolean(draft.trim() || quote.trim())
      : pending
        ? pending.kind === "pin"
          ? Boolean(draft.trim())
          : true
        : false;

  return (
    <div className="library-pdf-notes">
      {replaceDialog}
      <div className="library-pdf-notes-toolbar">
        <button type="button" className="btn btn-quiet" onClick={() => setPdfOpen((v) => !v)}>
          {pdfOpen ? "Hide PDF" : "Show PDF"}
        </button>
        <div className="library-ann-tools" role="tablist" aria-label="PDF pane">
          <button
            type="button"
            role="tab"
            className={`btn btn-ghost library-ann-tool${pane === "annotate" ? " is-active" : ""}`}
            aria-selected={pane === "annotate"}
            onClick={() => setPane("annotate")}
          >
            Highlights
          </button>
          <button
            type="button"
            role="tab"
            className={`btn btn-ghost library-ann-tool${pane === "facts" ? " is-active" : ""}`}
            aria-selected={pane === "facts"}
            onClick={() => setPane("facts")}
          >
            Facts
          </button>
        </div>
        {pane === "annotate" ? (
          <>
            <div className="library-ann-tools" role="toolbar" aria-label="Annotation tools">
              {(
                [
                  ["select", "Select"],
                  ["highlight", "Highlight"],
                  ["underline", "Underline"],
                  ["area", "Area"],
                  ["pin", "Pin"],
                  ["note", "Note"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`btn btn-ghost library-ann-tool${tool === id ? " is-active" : ""}`}
                  aria-pressed={tool === id}
                  onClick={() => {
                    setTool(id);
                    if (id !== "note") setPending(null);
                    if (id !== "select") {
                      setEditingId(null);
                      setDraft("");
                      setQuote("");
                    }
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="library-ann-colors" role="group" aria-label="Annotation color">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`library-ann-swatch${color === c ? " is-active" : ""}`}
                  style={{ background: c }}
                  title={c}
                  aria-label={`Color ${c}`}
                  aria-pressed={color === c}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
            <label className="library-ann-filter muted">
              <select
                value={pageFilter}
                onChange={(e) => setPageFilter(e.target.value as "all" | "page")}
              >
                <option value="all">All pages</option>
                <option value="page">Page {visiblePage}</option>
              </select>
            </label>
          </>
        ) : null}
      </div>

      {pane === "annotate" ? (
        <p className="muted library-hint library-ann-hint">
          {tool === "select"
            ? "Click a mark or list item to edit. Jump with the page badge."
            : tool === "pin"
              ? "Click the PDF to drop a pin, then write a note."
              : tool === "note"
                ? "Write a free note (optionally tied to the visible page)."
                : `Drag on the PDF to draw a ${tool}, then optionally add a note.`}
        </p>
      ) : (
        <p className="muted library-hint library-ann-hint">
          {tagSession
            ? tagSession.tool === "text"
              ? "Select text in the PDF to tag this fact (auto-confirms)."
              : "Drag a box on the PDF to tag this fact (auto-confirms)."
            : "Ask the PDF for a statement, value, question, or tagged location — or tag manually with box/text. Drop a PDF anywhere on this paper column to replace it."}
        </p>
      )}

      {pdfOpen ? (
        <div className="library-pdf-frame">
          <PdfViewer
            url={pdfUrl}
            shiftClickHint={null}
            highlight={flash}
            annotations={marks}
            interactionMode={interactionMode}
            onAreaSelect={
              pane === "annotate" ? onAreaSelect : pane === "facts" && tagSession ? onFactAreaSelect : undefined
            }
            onTextSelect={pane === "facts" && tagSession?.tool === "text" ? onFactTextSelect : undefined}
            onCommentAt={pane === "annotate" ? onPinAt : undefined}
            onAnnotationClick={(id) => {
              if (pane === "facts") {
                const factId = id.split(":")[0] ?? id;
                setSelectedFactId(factId);
                const mark = factMarks.find((m) => m.id === id || m.id.startsWith(`${factId}:`));
                if (mark) {
                  setFlash({
                    page: mark.page,
                    x: mark.x,
                    y: mark.y,
                    width: mark.w ?? 160,
                    height: mark.h ?? 18,
                    fullWidth: false,
                    label: mark.label,
                    nonce: Date.now(),
                  });
                }
                return;
              }
              const hit = annotations.find((a) => a.id === id);
              if (hit) beginEdit(hit);
            }}
            onVisiblePageChange={setVisiblePage}
          />
        </div>
      ) : null}

      {pane === "facts" ? (
        <LibraryPaperFacts
          paper={paper}
          onError={onError}
          focusFactId={focusFactId}
          onFlash={setFlash}
          onMarksChange={setFactMarks}
          selectedFactId={selectedFactId}
          onSelectedFactIdChange={setSelectedFactId}
          tagSession={tagSession}
          onTagSessionChange={setTagSession}
          tagRectRef={tagRectRef}
          onTagged={() => setPdfOpen(true)}
        />
      ) : (
        <>
          {composing ? (
            <div className="library-pdf-pin-form">
              <p className="muted">
                {editing
                  ? `Edit ${kindLabel(editing.kind)}${editing.page != null ? ` · p.${editing.page}` : ""}`
                  : pending
                    ? `${kindLabel(pending.kind)} on page ${pending.page}`
                    : `New note${visiblePage ? ` · p.${visiblePage}` : ""}`}
              </p>
              <input
                className="library-ann-quote"
                type="text"
                value={quote}
                onChange={(e) => setQuote(e.target.value)}
                placeholder="Quoted text (optional)"
              />
              <textarea
                className="library-notes"
                rows={3}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={
                  pending?.kind === "pin" || tool === "note"
                    ? "Write your note…"
                    : "Optional note for this mark…"
                }
                autoFocus
              />
              <div className="library-pdf-pin-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || (editing ? false : !canSaveCreate)}
                  onClick={() => void (editing ? saveEdit() : saveCreate())}
                >
                  {editing ? "Save changes" : "Save"}
                </button>
                <button type="button" className="btn btn-ghost" onClick={resetComposer}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          <ul className="library-annotation-list">
            {!filtered.length ? (
              <li className="muted">
                {annotations.length
                  ? "No annotations on this page."
                  : "No annotations yet — pick a tool and mark the PDF."}
              </li>
            ) : null}
            {filtered.map((a) => (
              <li
                key={a.id}
                className={`library-annotation-item${editingId === a.id ? " is-selected" : ""}`}
              >
                <button
                  type="button"
                  className="library-annotation-jump"
                  onClick={() => beginEdit(a)}
                >
                  <span
                    className="library-annotation-swatch"
                    style={{ background: a.color || COLORS[0] }}
                    aria-hidden
                  />
                  <span className="library-annotation-kind">{kindLabel(a.kind)}</span>
                  {a.page != null ? <span className="library-annotation-page">p.{a.page}</span> : null}
                  <span className="library-annotation-body">
                    {a.quote ? <em>“{a.quote}”</em> : null}
                    {a.quote && a.body ? " — " : null}
                    {a.body || (a.quote ? "" : "(mark only)")}
                  </span>
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  title="Delete annotation"
                  aria-label="Delete annotation"
                  onClick={() => {
                    void deleteLibraryAnnotation(paper.citekey, a.id)
                      .then(() => {
                        if (editingId === a.id) resetComposer();
                        return refresh();
                      })
                      .catch((err) =>
                        onError?.(err instanceof Error ? err.message : "Delete failed"),
                      );
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
