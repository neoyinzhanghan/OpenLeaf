import { useCallback, useEffect, useState } from "react";
import {
  createLibraryAnnotation,
  deleteLibraryAnnotation,
  libraryPdfUrl,
  listLibraryAnnotations,
} from "../api/client";
import type { PaperAnnotation, PaperRecord } from "../api/types";
import { PdfViewer, type PdfHighlight } from "./PdfViewer";

type Props = {
  paper: PaperRecord;
  onError?: (message: string) => void;
};

export function LibraryPdfNotes({ paper, onError }: Props) {
  const [annotations, setAnnotations] = useState<PaperAnnotation[]>([]);
  const [flash, setFlash] = useState<PdfHighlight | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingPin, setPendingPin] = useState<{ page: number; x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(Boolean(paper.attachment));

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
    setPendingPin(null);
    setDraft("");
    setFlash(null);
  }, [paper.citekey, paper.attachment, refresh]);

  const savePin = async () => {
    if (!pendingPin || !draft.trim()) return;
    setBusy(true);
    try {
      await createLibraryAnnotation(paper.citekey, {
        kind: "highlight",
        body: draft.trim(),
        page: pendingPin.page,
        x: pendingPin.x,
        y: pendingPin.y,
        h: 18,
        w: 160,
      });
      setDraft("");
      setPendingPin(null);
      await refresh();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Could not save highlight");
    } finally {
      setBusy(false);
    }
  };

  if (!paper.attachment) {
    return (
      <p className="muted library-hint">
        No PDF attached. Import a PDF for this paper to highlight and take page-linked notes.
      </p>
    );
  }

  const pdfUrl = libraryPdfUrl(paper.citekey);

  return (
    <div className="library-pdf-notes">
      <div className="library-pdf-notes-toolbar">
        <button type="button" className="btn btn-quiet" onClick={() => setPdfOpen((v) => !v)}>
          {pdfOpen ? "Hide PDF" : "Show PDF"}
        </button>
        <span className="muted library-hint">Shift+click the PDF to pin a highlight note</span>
      </div>

      {pdfOpen ? (
        <div className="library-pdf-frame">
          <PdfViewer
            url={pdfUrl}
            shiftClickHint="Shift+click → highlight note"
            highlight={flash}
            onCommentAt={(page, x, y) => {
              setPendingPin({ page, x, y });
              setFlash({ page, x, y, width: 160, height: 18, fullWidth: false, nonce: Date.now() });
            }}
          />
        </div>
      ) : null}

      {pendingPin ? (
        <div className="library-pdf-pin-form">
          <p className="muted">
            Pin on page {pendingPin.page} — write a note for this highlight:
          </p>
          <textarea
            className="library-notes"
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Why this passage matters…"
            autoFocus
          />
          <div className="library-pdf-pin-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !draft.trim()}
              onClick={() => void savePin()}
            >
              Save highlight
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setPendingPin(null);
                setDraft("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <ul className="library-annotation-list">
        {!annotations.length ? <li className="muted">No PDF highlights yet.</li> : null}
        {annotations.map((a) => (
          <li key={a.id} className="library-annotation-item">
            <button
              type="button"
              className="library-annotation-jump"
              onClick={() => {
                if (a.page != null && a.x != null && a.y != null) {
                  setPdfOpen(true);
                  setFlash({
                    page: a.page,
                    x: a.x,
                    y: a.y,
                    width: a.w ?? 160,
                    height: a.h ?? 18,
                    fullWidth: false,
                    label: a.body.slice(0, 48),
                    nonce: Date.now(),
                  });
                }
              }}
            >
              {a.page != null ? <span className="library-annotation-page">p.{a.page}</span> : null}
              <span className="library-annotation-body">
                {a.quote ? <em>“{a.quote}”</em> : null}
                {a.quote && a.body ? " — " : null}
                {a.body || "(empty)"}
              </span>
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              title="Delete annotation"
              onClick={() => {
                void deleteLibraryAnnotation(paper.citekey, a.id)
                  .then(() => refresh())
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
