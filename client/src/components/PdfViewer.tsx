import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

const MIN_SCALE = 0.6;
const MAX_SCALE = 2.4;
const SCALE_STEP = 0.1;

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

export type PdfDiffOverlay = {
  page: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
};

export type PdfDiffHighlightControls = {
  enabled: boolean;
  since: string;
  commits: Array<{ hash: string; shortHash: string; message: string; date: string }>;
  lineCount: number | null;
  fileCount: number | null;
  loading?: boolean;
  warning?: string | null;
  onEnabledChange: (on: boolean) => void;
  onSinceChange: (hash: string) => void;
};

type Props = {
  url: string | null;
  onReverseSearch?: (page: number, x: number, y: number) => void;
  /** Shift+click PDF → create a comment at the SyncTeX source hit */
  onCommentAt?: (page: number, x: number, y: number) => void;
  highlight?: PdfHighlight | null;
  /** Persistent git-diff addition marks (not the SyncTeX flash) */
  overlays?: PdfDiffOverlay[];
  diffHighlight?: PdfDiffHighlightControls | null;
};

type ScrollAnchor = {
  page: number;
  /** Fraction through the anchored page wrap (viewport midpoint) */
  offsetRatio: number;
};

function clampScale(scale: number): number {
  const stepped = Math.round(scale / SCALE_STEP) * SCALE_STEP;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(stepped.toFixed(1))));
}

function formatDiffWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function truncateMsg(msg: string, max = 36): string {
  const t = msg.trim() || "snapshot";
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function captureScrollAnchor(scroller: HTMLElement, container: HTMLElement): ScrollAnchor | null {
  const wraps = [...container.querySelectorAll(".pdf-page-wrap")] as HTMLElement[];
  if (wraps.length === 0) return null;
  const mid = scroller.scrollTop + scroller.clientHeight / 2;
  let best = wraps[0]!;
  for (const wrap of wraps) {
    if (wrap.offsetTop <= mid) best = wrap;
    else break;
  }
  const page = Number(best.dataset.page) || 1;
  const offsetRatio = best.offsetHeight > 0 ? (mid - best.offsetTop) / best.offsetHeight : 0;
  return { page, offsetRatio };
}

function restoreScrollAnchor(
  scroller: HTMLElement,
  container: HTMLElement,
  anchor: ScrollAnchor | null,
): void {
  if (!anchor) return;
  const wrap = container.querySelector(
    `.pdf-page-wrap[data-page="${anchor.page}"]`,
  ) as HTMLElement | null;
  if (!wrap) return;
  const mid = wrap.offsetTop + anchor.offsetRatio * wrap.offsetHeight;
  const top = Math.max(0, mid - scroller.clientHeight / 2);
  const prev = scroller.style.scrollBehavior;
  scroller.style.scrollBehavior = "auto";
  scroller.scrollTop = top;
  scroller.style.scrollBehavior = prev;
}

export function PdfViewer({
  url,
  onReverseSearch,
  onCommentAt,
  highlight,
  overlays,
  diffHighlight,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const reverseRef = useRef(onReverseSearch);
  reverseRef.current = onReverseSearch;
  const commentRef = useRef(onCommentAt);
  commentRef.current = onCommentAt;
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const scaleRef = useRef(1.2);
  const renderedScaleRef = useRef(1.2);
  const scrolledFlashNonceRef = useRef<number | null>(null);

  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState<PdfHighlight | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  /** Bumps when the loaded document identity changes so pages re-render. */
  const [docVersion, setDocVersion] = useState(0);
  const [pagesReady, setPagesReady] = useState(false);

  scaleRef.current = scale;

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        setFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  useEffect(() => {
    if (!highlight) return;
    setFlash(highlight);
    const t = window.setTimeout(() => setFlash(null), 3500);
    return () => window.clearTimeout(t);
  }, [highlight]);

  // Load / replace the PDF document only when the URL changes.
  useEffect(() => {
    if (!url) {
      docRef.current?.destroy().catch(() => undefined);
      docRef.current = null;
      setPageCount(0);
      setPagesReady(false);
      setLoading(false);
      setError(null);
      if (containerRef.current) containerRef.current.innerHTML = "";
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const doc = await pdfjs.getDocument(url).promise;
        if (cancelled) {
          await doc.destroy().catch(() => undefined);
          return;
        }
        const prev = docRef.current;
        docRef.current = doc;
        prev?.destroy().catch(() => undefined);
        if (containerRef.current) containerRef.current.innerHTML = "";
        renderedScaleRef.current = scaleRef.current;
        setPagesReady(false);
        setPageCount(doc.numPages);
        setDocVersion((v) => v + 1);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load PDF");
          setPageCount(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url]);

  // Render (or re-render) pages when the document or zoom changes — no loading flash on zoom.
  useEffect(() => {
    const doc = docRef.current;
    const container = containerRef.current;
    const scroller = scrollRef.current;
    if (!doc || !container || !url) return;

    let cancelled = false;
    let activeRender: { cancel: () => void } | null = null;
    const renderScale = scale;
    const anchor = scroller ? captureScrollAnchor(scroller, container) : null;
    const wraps = [...container.querySelectorAll(".pdf-page-wrap")] as HTMLElement[];
    const hadPages = wraps.length > 0;

    // Instantly rescale existing page boxes (stretch old bitmaps) and pin scroll
    // before the async crisp re-paint, so zoom never jumps to the top.
    if (hadPages && scroller) {
      const prevScale = renderedScaleRef.current;
      if (prevScale > 0 && prevScale !== renderScale) {
        const ratio = renderScale / prevScale;
        for (const wrap of wraps) {
          wrap.style.width = `${wrap.offsetWidth * ratio}px`;
          wrap.style.height = `${wrap.offsetHeight * ratio}px`;
        }
      }
      restoreScrollAnchor(scroller, container, anchor);
      renderedScaleRef.current = renderScale;
    }

    (async () => {
      try {
        for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
          if (cancelled) return;
          const page = await doc.getPage(pageNum);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: renderScale });

          let wrap = container.querySelector(
            `.pdf-page-wrap[data-page="${pageNum}"]`,
          ) as HTMLElement | null;
          let canvas: HTMLCanvasElement;

          if (!wrap) {
            wrap = document.createElement("div");
            wrap.className = "pdf-page-wrap";
            wrap.dataset.page = String(pageNum);
            canvas = document.createElement("canvas");
            canvas.className = "pdf-page";
            canvas.dataset.page = String(pageNum);
            canvas.title = "Click → source · Shift+click → comment";
            canvas.addEventListener("click", (ev) => {
              const rect = canvas.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) return;
              const currentScale = scaleRef.current;
              const canvasX = ((ev.clientX - rect.left) / rect.width) * canvas.width;
              const canvasY = ((ev.clientY - rect.top) / rect.height) * canvas.height;
              const x = canvasX / currentScale;
              const y = canvasY / currentScale;

              wrap!.querySelectorAll(".pdf-click-pulse").forEach((el) => el.remove());
              const pulse = document.createElement("div");
              pulse.className = "pdf-click-pulse";
              pulse.style.left = `${ev.clientX - rect.left - 10}px`;
              pulse.style.top = `${ev.clientY - rect.top - 10}px`;
              wrap!.appendChild(pulse);
              window.setTimeout(() => pulse.remove(), 700);

              if (ev.shiftKey && commentRef.current) {
                commentRef.current(pageNum, x, y);
                return;
              }
              reverseRef.current?.(pageNum, x, y);
            });
            wrap.appendChild(canvas);
            container.appendChild(wrap);
          } else {
            canvas = wrap.querySelector("canvas") as HTMLCanvasElement;
            if (!canvas) continue;
          }

          wrap.style.width = `${viewport.width}px`;
          wrap.style.height = `${viewport.height}px`;
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          const task = page.render({ canvasContext: ctx, viewport });
          activeRender = task;
          try {
            await task.promise;
          } catch {
            // Cancelled renders reject — ignore when superseded by a newer zoom.
            if (cancelled) return;
            throw new Error("Failed to render PDF page");
          } finally {
            if (activeRender === task) activeRender = null;
          }
          if (cancelled) return;
        }

        if (!cancelled) {
          renderedScaleRef.current = renderScale;
          setPagesReady(true);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to render PDF");
        }
      }
    })();

    return () => {
      cancelled = true;
      activeRender?.cancel();
    };
  }, [url, docVersion, scale]);

  // Ctrl/Cmd + mouse wheel zoom (browser-style).
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onWheel = (ev: WheelEvent) => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      const direction = ev.deltaY > 0 ? -1 : 1;
      setScale((s) => clampScale(s + direction * SCALE_STEP));
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, []);

  // SyncTeX highlight marks — reposition on zoom without re-scrolling.
  useEffect(() => {
    if (!flash || !containerRef.current || loading) return;
    const wrap = containerRef.current.querySelector(
      `.pdf-page-wrap[data-page="${flash.page}"]`,
    ) as HTMLElement | null;
    if (!wrap) return;

    containerRef.current.querySelectorAll(".pdf-sync-mark, .pdf-sync-label").forEach((el) => el.remove());

    const pageW = wrap.clientWidth;
    const h = Math.max((flash.height ?? 16) * scale, 18);
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

    const flashKey = flash.nonce ?? flash.page * 1e9 + flash.x * 1e3 + flash.y;
    if (scrolledFlashNonceRef.current === flashKey) return;
    scrolledFlashNonceRef.current = flashKey;

    wrap.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    const scroller = scrollRef.current;
    if (scroller) {
      const wrapTop = wrap.offsetTop;
      const target = wrapTop + top - scroller.clientHeight / 2 + h / 2;
      scroller.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    }
  }, [flash, scale, pageCount, loading]);

  // Git-diff addition overlays — persist until toggled off; no scroll jump.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.querySelectorAll(".pdf-diff-mark").forEach((el) => el.remove());
    if (!overlays?.length || !pagesReady || loading) return;

    for (const box of overlays) {
      const wrap = container.querySelector(
        `.pdf-page-wrap[data-page="${box.page}"]`,
      ) as HTMLElement | null;
      if (!wrap) continue;
        const h = Math.max((box.height ?? 12) * scale, 8);
        const top = Math.max(0, box.y * scale);
        const left = Math.max(0, box.x * scale);
        const width = Math.max((box.width ?? 40) * scale, 8);
      const mark = document.createElement("div");
      mark.className = "pdf-diff-mark";
      mark.style.left = `${left}px`;
      mark.style.top = `${top}px`;
      mark.style.width = `${width}px`;
      mark.style.height = `${h}px`;
      wrap.appendChild(mark);
    }
  }, [overlays, scale, pagesReady, loading, docVersion]);

  return (
    <div
      className={`pane pdf-pane${fullscreen ? " pdf-pane--fullscreen" : ""}`}
      style={{ height: "100%" }}
    >
      <div className="pdf-toolbar">
        <span className="pane-title" style={{ padding: 0 }}>
          PDF
        </span>
        <span
          className="status-pill"
          title="Click PDF → source · Shift+click → comment · Ctrl/Cmd+Click source → PDF · Ctrl/Cmd+scroll to zoom"
        >
          SyncTeX
        </span>
        {diffHighlight && (
          <div className="pdf-diff-controls">
            <button
              type="button"
              className={`btn btn-ghost${diffHighlight.enabled ? " pdf-diff-toggle-on" : ""}`}
              aria-pressed={diffHighlight.enabled}
              title="Highlight manuscript text added since a git snapshot. Overlay only — the downloaded PDF stays clean."
              onClick={() => diffHighlight.onEnabledChange(!diffHighlight.enabled)}
            >
              {diffHighlight.enabled ? "Additions on" : "Highlight additions"}
            </button>
            {diffHighlight.enabled && (
              <>
                <label className="pdf-diff-since">
                  <span>since</span>
                  <select
                    value={diffHighlight.since}
                    onChange={(e) => diffHighlight.onSinceChange(e.target.value)}
                    aria-label="Highlight additions since this snapshot"
                    disabled={diffHighlight.commits.length === 0}
                  >
                    {diffHighlight.commits.length === 0 ? (
                      <option value="">No snapshots</option>
                    ) : (
                      <>
                        {diffHighlight.since &&
                          !diffHighlight.commits.some((c) => c.hash === diffHighlight.since) && (
                            <option value={diffHighlight.since}>
                              {diffHighlight.since.slice(0, 7)}
                            </option>
                          )}
                        {diffHighlight.commits.map((c) => (
                          <option key={c.hash} value={c.hash}>
                            {c.shortHash} · {formatDiffWhen(c.date)} · {truncateMsg(c.message)}
                          </option>
                        ))}
                      </>
                    )}
                  </select>
                </label>
                <span
                  className="status-pill"
                  title={diffHighlight.warning ?? "Added .tex lines mapped onto the PDF via SyncTeX"}
                >
                  {diffHighlight.loading
                    ? "…"
                    : diffHighlight.lineCount != null
                      ? `${diffHighlight.lineCount} line${diffHighlight.lineCount === 1 ? "" : "s"}${
                          diffHighlight.fileCount != null && diffHighlight.fileCount > 0
                            ? ` · ${diffHighlight.fileCount} file${diffHighlight.fileCount === 1 ? "" : "s"}`
                            : ""
                        }`
                      : "—"}
                </span>
              </>
            )}
          </div>
        )}
        <div className="spacer" />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setScale((s) => clampScale(s - SCALE_STEP))}
          title="Zoom out"
        >
          −
        </button>
        <span className="status-pill">{Math.round(scale * 100)}%</span>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setScale((s) => clampScale(s + SCALE_STEP))}
          title="Zoom in"
        >
          +
        </button>
        {pageCount > 0 && <span className="status-pill">{pageCount} pages</span>}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setFullscreen((v) => !v)}
          title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}
          aria-pressed={fullscreen}
          aria-label={fullscreen ? "Exit full screen" : "Full screen"}
        >
          {fullscreen ? "Exit full screen" : "Full screen"}
        </button>
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
