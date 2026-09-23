import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createLibraryAnnotation,
  deleteLibraryAnnotation,
  libraryPdfUrl,
  listLibraryAnnotations,
  patchLibraryAnnotation,
} from "../api/client";
import type { PaperAnnotation, PaperRecord } from "../api/types";
import {
  PdfViewer,
  type PdfAnnotationMark,
  type PdfAreaRect,
  type PdfHighlight,
  type PdfInteractionMode,
} from "./PdfViewer";

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
  onError?: (message: string) => void;
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

export function LibraryPdfNotes({ paper, onError }: Props) {
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

  const refresh = useCallback(async () => {
    try {
      const { annotations: list } = await listLibraryAnnotations(paper.citekey);
      setAnnotations(list);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Could not load annotations");
    }
  }, [paper.citekey, onError]);

  useEffect(() => {
    void refresh();
    setPdfOpen(Boolean(paper.attachment));
    setPending(null);
    setEditingId(null);
    setDraft("");
    setQuote("");
    setFlash(null);
    setVisiblePage(1);
  }, [paper.citekey, paper.attachment, refresh]);

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

  const marks = useMemo(
    () => toMarks(annotations, editingId),
    [annotations, editingId],
  );

  const filtered = useMemo(() => {
    if (pageFilter === "all") return annotations;
    return annotations.filter((a) => a.page == null || a.page === visiblePage);
  }, [annotations, pageFilter, visiblePage]);

  const interactionMode: PdfInteractionMode =
    tool === "select" || tool === "note" ? "sync" : tool;

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
    setPending({ kind: "pin", page, x, y, w: 14, h: 14 });
    setFlash({ page, x, y, width: 14, height: 14, fullWidth: false, nonce: Date.now() });
  };

  if (!paper.attachment) {
    return (
      <p className="muted library-hint">
        No PDF attached. Import or download a PDF to highlight, underline, pin, and annotate.
      </p>
    );
  }

  const pdfUrl = libraryPdfUrl(paper.citekey);
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
      <div className="library-pdf-notes-toolbar">
        <button type="button" className="btn btn-quiet" onClick={() => setPdfOpen((v) => !v)}>
          {pdfOpen ? "Hide PDF" : "Show PDF"}
        </button>
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
                if (id !== "select") setEditingId(null);
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
      </div>

      <p className="muted library-hint library-ann-hint">
        {tool === "select"
          ? "Click a mark or list item to edit. Jump with the page badge."
          : tool === "pin"
            ? "Click the PDF to drop a pin, then write a note."
            : tool === "note"
              ? "Write a free note (optionally tied to the visible page)."
              : `Drag on the PDF to draw a ${tool}, then optionally add a note.`}
      </p>

      {pdfOpen ? (
        <div className="library-pdf-frame">
          <PdfViewer
            url={pdfUrl}
            shiftClickHint={null}
            highlight={flash}
            annotations={marks}
            interactionMode={interactionMode}
            onAreaSelect={onAreaSelect}
            onCommentAt={onPinAt}
            onAnnotationClick={(id) => {
              const hit = annotations.find((a) => a.id === id);
              if (hit) beginEdit(hit);
            }}
            onVisiblePageChange={setVisiblePage}
          />
        </div>
      ) : null}

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
    </div>
  );
}
