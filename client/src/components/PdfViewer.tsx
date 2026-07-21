import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

export type PdfHighlight = {
  page: number;
  /** Top-left origin, PDF points (y down) */
  x: number;
  y: number;
  width?: number;
  height?: number;
  /** Stretch highlight across the page content width */
  fullWidth?: boolean;
  label?: string;
  /** Force re-flash even if coords unchanged */
  nonce?: number;
};

type Props = {
  url: string | null;
  onReverseSearch?: (page: number, x: number, y: number) => void;
  highlight?: PdfHighlight | null;
};

export function PdfViewer({ url, onReverseSearch, highlight }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const reverseRef = useRef(onReverseSearch);
  reverseRef.current = onReverseSearch;
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState<PdfHighlight | null>(null);
  /** Preserve scroll across intentional reloads (e.g. zoom) */
  const scrollRestoreRef = useRef<number | null>(null);

  useEffect(() => {
    if (!highlight) return;
    setFlash(highlight);
    const t = window.setTimeout(() => setFlash(null), 3500);
    return () => window.clearTimeout(t);
  }, [highlight]);

  useEffect(() => {
    if (!url) {
      setPageCount(0);
      return;
    }

    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    // Keep place when re-rendering for zoom; never jump to top on callback churn
    if (scrollRef.current) {
      scrollRestoreRef.current = scrollRef.current.scrollTop;
    }

    container.innerHTML = "";
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const doc = await pdfjs.getDocument(url).promise;
        if (cancelled) return;
        setPageCount(doc.numPages);

        for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
          const page = await doc.getPage(pageNum);
          if (cancelled) return;
          const viewport = page.getViewport({ scale });
          const wrap = document.createElement("div");
          wrap.className = "pdf-page-wrap";
          wrap.dataset.page = String(pageNum);
          wrap.style.width = `${viewport.width}px`;
          wrap.style.height = `${viewport.height}px`;

          const canvas = document.createElement("canvas");
          canvas.className = "pdf-page";
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.dataset.page = String(pageNum);
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport }).promise;
          canvas.addEventListener("click", (ev) => {
            const handler = reverseRef.current;
            if (!handler) return;
            const rect = canvas.getBoundingClientRect();
            const xCss = ev.clientX - rect.left;
            const yCss = ev.clientY - rect.top;
            // Top-left origin (y down), PDF points — matches SyncTeX from pdfTeX
            const x = xCss / scale;
            const y = yCss / scale;

            // Local click pulse for feedback
            wrap.querySelectorAll(".pdf-click-pulse").forEach((el) => el.remove());
            const pulse = document.createElement("div");
            pulse.className = "pdf-click-pulse";
            pulse.style.left = `${xCss - 10}px`;
            pulse.style.top = `${yCss - 10}px`;
            wrap.appendChild(pulse);
            window.setTimeout(() => pulse.remove(), 700);

            handler(pageNum, x, y);
          });
          canvas.title = "Click to jump to LaTeX source";
          wrap.appendChild(canvas);
          container.appendChild(wrap);
        }

        // Restore scroll after zoom/reload (not after SyncTeX — that path no longer reloads)
        const restore = scrollRestoreRef.current;
        if (restore != null && scrollRef.current) {
          scrollRef.current.scrollTop = restore;
          scrollRestoreRef.current = null;
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load PDF");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Intentionally omit onReverseSearch — use reverseRef so file switches don't reload the PDF
  }, [url, scale]);

  useEffect(() => {
    if (!flash || !containerRef.current || loading) return;
    const wrap = containerRef.current.querySelector(
      `.pdf-page-wrap[data-page="${flash.page}"]`,
    ) as HTMLElement | null;
    if (!wrap) return;

    containerRef.current.querySelectorAll(".pdf-sync-mark, .pdf-sync-label").forEach((el) => el.remove());

    const pageW = wrap.clientWidth;
    const h = Math.max((flash.height ?? 16) * scale, 18);
    // Synctex y is baseline-ish from top; pad upward a bit for a readable band
    const top = Math.max(0, flash.y * scale - h * 0.35);
    const left = flash.fullWidth !== false ? pageW * 0.06 : Math.max(0, flash.x * scale - 4);
    const width =
      flash.fullWidth !== false
        ? pageW * 0.88
        : Math.max((flash.width ?? 80) * scale, 64);

    const mark = document.createElement("div");
    mark.className = "pdf-sync-mark";
    mark.style.left = `${left}px`;
    mark.style.top = `${top}px`;
    mark.style.width = `${width}px`;
    mark.style.height = `${h}px`;
    wrap.appendChild(mark);

    const label = document.createElement("div");
    label.className = "pdf-sync-label";
    label.textContent = flash.label ?? `Page ${flash.page}`;
    label.style.left = `${left}px`;
    label.style.top = `${Math.max(0, top - 22)}px`;
    wrap.appendChild(label);

    wrap.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    // Also nudge the scroll parent in case nested scroll containers fight scrollIntoView
    const scroller = scrollRef.current;
    if (scroller) {
      const wrapTop = wrap.offsetTop;
      const target = wrapTop + top - scroller.clientHeight / 2 + h / 2;
      scroller.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    }
  }, [flash, scale, pageCount, loading]);

  return (
    <div className="pane pdf-pane" style={{ height: "100%" }}>
      <div className="pdf-toolbar">
        <span className="pane-title" style={{ padding: 0 }}>
          PDF
        </span>
        <span className="status-pill" title="Click PDF → source · Ctrl/Cmd+Click source → PDF">
          SyncTeX
        </span>
        <div className="spacer" />
        <button type="button" className="btn btn-ghost" onClick={() => setScale((s) => Math.max(0.6, s - 0.1))}>
          −
        </button>
        <span className="status-pill">{Math.round(scale * 100)}%</span>
        <button type="button" className="btn btn-ghost" onClick={() => setScale((s) => Math.min(2.4, s + 0.1))}>
          +
        </button>
        {pageCount > 0 && <span className="status-pill">{pageCount} pages</span>}
      </div>
      {!url && <div className="empty-hint">Compile to preview the PDF.</div>}
      {loading && <div className="empty-hint">Loading PDF…</div>}
      {error && (
        <div className="error-banner" style={{ margin: "1rem" }}>
          {error}
        </div>
      )}
      <div className="pdf-scroll" ref={scrollRef}>
        <div ref={containerRef} />
      </div>
    </div>
  );
}
