import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { citationLinkAtPoint, citekeyFromPdfDest, type PdfCiteLink } from "../latex/libraryLink";
import { isTransientPdfError, isTransientPdfErrorMessage } from "../lib/transientErrors";
import { ErrorBanner } from "./ErrorBanner";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

// PDF.js always destroys the worker passed to getDocument when the loading task
// / document is destroyed. Sharing one worker across papers therefore kills the
// *next* PDF's transport (sendWithPromise on null) when the previous doc is
// dropped — which is exactly what Facts/Library do when switching papers.
// Let each document own its worker; workerSrc above still caches the script.
let pdfLoadGate: Promise<void> = Promise.resolve();

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
  /** Stretch highlight across the page content width (horizontal table rows). */
  fullWidth?: boolean;
  /** Stretch highlight down the page content height (vertical/rotated table cells). */
  fullHeight?: boolean;
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

/** Persistent library/project annotation marks on the PDF canvas. */
export type PdfAnnotationMark = {
  id: string;
  kind: "highlight" | "underline" | "area" | "pin" | "note";
  page: number;
  x: number;
  y: number;
  w?: number;
  h?: number;
  color?: string;
  label?: string;
  selected?: boolean;
  rects?: Array<{ x: number; y: number; w: number; h: number }>;
};

export type PdfInteractionMode = "sync" | "pin" | "highlight" | "underline" | "area" | "text";

export type PdfAreaRect = {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

/** Native text-layer selection (page + quote + covering bbox). */
export type PdfTextSelection = PdfAreaRect & { quote: string };

export type PdfDiffHighlightControls = {
  enabled: boolean;
  /** Baseline commit hash to compare against */
  baselineHash: string;
  /** Short human label for the baseline (message / hash) */
  baselineLabel: string;
  /** @deprecated prefer additions/deletions */
  lineCount: number | null;
  fileCount: number | null;
  additions: number | null;
  deletions: number | null;
  loading?: boolean;
  warning?: string | null;
  onEnabledChange: (on: boolean) => void;
  onPickBaseline: () => void;
  /** Experimental: show the latexdiff PDF in the preview instead of SyncTeX overlays. */
  markupPdf?: {
    enabled: boolean;
    available: boolean;
    loading: boolean;
    onEnabledChange: (on: boolean) => void;
  };
};

type Props = {
  url: string | null;
  /** Shown when there is no PDF URL yet (e.g. auto-building after a branch switch). */
  emptyHint?: string | null;
  onReverseSearch?: (page: number, x: number, y: number) => void;
  /** Click a compiled citation → open that paper in the reference library. */
  onCitationClick?: (citekey: string) => void;
  /** Shift+click PDF → create a comment at the SyncTeX source hit */
  onCommentAt?: (page: number, x: number, y: number) => void;
  /** Toolbar hint for shift+click; pass null to hide. */
  shiftClickHint?: string | null;
  highlight?: PdfHighlight | null;
  /** Persistent git-diff addition marks (not the SyncTeX flash) */
  overlays?: PdfDiffOverlay[];
  /** Persistent annotation marks (library / optional project notes). */
  annotations?: PdfAnnotationMark[];
  /**
   * Interaction mode. Default "sync" preserves Editor SyncTeX click/shift-click.
   * Library annotate modes: pin (click), highlight/underline/area (drag rect).
   * "text" enables a selectable text layer for fact tagging.
   */
  interactionMode?: PdfInteractionMode;
  onAreaSelect?: (rect: PdfAreaRect) => void;
  /** Fired when the user selects text in "text" mode. */
  onTextSelect?: (sel: PdfTextSelection) => void;
  onAnnotationClick?: (id: string) => void;
  onVisiblePageChange?: (page: number) => void;
  diffHighlight?: PdfDiffHighlightControls | null;
  /** Remembered zoom is per project. Narrow screens always fit the page width. */
  projectId?: string;
  /** Shown when this build failed but an older PDF is still on screen. */
  staleBanner?: string | null;
};

type ScrollAnchor = {
  page: number;
  /** Fraction through the anchored page wrap (viewport midpoint) */
  offsetRatio: number;
  scrollLeft: number;
};

function clampScale(scale: number): number {
  const stepped = Math.round(scale / SCALE_STEP) * SCALE_STEP;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(stepped.toFixed(1))));
}

function scaleStorageKey(projectId: string): string {
  return `openleaf.pdfScale.${projectId}`;
}

function fitWidthScale(pageWidth: number, scroller: HTMLElement | null): number {
  const available = Math.max(200, (scroller?.clientWidth ?? 640) - 28);
  if (pageWidth <= 0) return 1;
  return clampScale(available / pageWidth);
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
  return { page, offsetRatio, scrollLeft: scroller.scrollLeft };
}

function restoreScrollAnchor(
  scroller: HTMLElement,
  container: HTMLElement,
  anchor: ScrollAnchor | null,
): void {
  if (!anchor) return;
  const wraps = [...container.querySelectorAll(".pdf-page-wrap")] as HTMLElement[];
  if (wraps.length === 0) return;
  const maxPage = wraps.reduce((max, wrap) => Math.max(max, Number(wrap.dataset.page) || 1), 1);
  const page = Math.min(Math.max(1, anchor.page), maxPage);
  const ratio = page === anchor.page ? anchor.offsetRatio : 1;
  const wrap = container.querySelector(`.pdf-page-wrap[data-page="${page}"]`) as HTMLElement | null;
  if (!wrap) return;
  const mid = wrap.offsetTop + ratio * wrap.offsetHeight;
  const top = Math.max(0, mid - scroller.clientHeight / 2);
  const prev = scroller.style.scrollBehavior;
  scroller.style.scrollBehavior = "auto";
  scroller.scrollTop = top;
  scroller.scrollLeft = anchor.scrollLeft;
  scroller.style.scrollBehavior = prev;
}

function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

/** Tear down painted canvases so GPU/backing-store memory is released promptly. */
function clearPdfDom(container: HTMLElement | null): void {
  if (!container) return;
  container.querySelectorAll("canvas").forEach((node) => {
    releaseCanvas(node as HTMLCanvasElement);
  });
  container.innerHTML = "";
}

export function PdfViewer({
  url,
  emptyHint,
  onReverseSearch,
  onCitationClick,
  onCommentAt,
  shiftClickHint,
  highlight,
  overlays,
  annotations,
  interactionMode = "sync",
  onAreaSelect,
  onTextSelect,
  onAnnotationClick,
  onVisiblePageChange,
  diffHighlight,
  projectId,
  staleBanner,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const reverseRef = useRef(onReverseSearch);
  reverseRef.current = onReverseSearch;
  const citationClickRef = useRef(onCitationClick);
  citationClickRef.current = onCitationClick;
  const citeLinksRef = useRef<Map<number, PdfCiteLink[]>>(new Map());
  const commentRef = useRef(onCommentAt);
  commentRef.current = onCommentAt;
  const modeRef = useRef(interactionMode);
  modeRef.current = interactionMode;
  const areaSelectRef = useRef(onAreaSelect);
  areaSelectRef.current = onAreaSelect;
  const textSelectRef = useRef(onTextSelect);
  textSelectRef.current = onTextSelect;
  const annClickRef = useRef(onAnnotationClick);
  annClickRef.current = onAnnotationClick;
  const visiblePageRef = useRef(onVisiblePageChange);
  visiblePageRef.current = onVisiblePageChange;
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const scaleRef = useRef(1);
  const renderedScaleRef = useRef(1);
  const fittedRef = useRef(false);
  const scrolledFlashNonceRef = useRef<number | null>(null);
  /** Place to return to after a recompile replaces the PDF URL. */
  const pendingAnchorRef = useRef<ScrollAnchor | null>(null);
  const pageSizesRef = useRef<Array<{ width: number; height: number }>>([]);
  const paintTokenRef = useRef(0);

  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1);
  const [error, setErrorState] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState<PdfHighlight | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  /** Bumps when the loaded document identity changes so pages re-render. */
  const [docVersion, setDocVersion] = useState(0);
  const [pagesReady, setPagesReady] = useState(false);

  const setError = (msg: string | null) => {
    if (msg && isTransientPdfErrorMessage(msg)) {
      setErrorState(null);
      return;
    }
    setErrorState(msg);
  };

  // Belt-and-suspenders: clear sticky PDF.js worker races even if something else set them.
  useEffect(() => {
    if (error && isTransientPdfErrorMessage(error)) setErrorState(null);
  }, [error]);

  scaleRef.current = scale;

  useEffect(() => {
    fittedRef.current = false;
  }, [projectId, url]);

  useEffect(() => {
    if (pageCount < 1 || fittedRef.current) return;
    const pageWidth = pageSizesRef.current[0]?.width ?? 0;
    if (pageWidth <= 0) return;
    const narrow = window.matchMedia("(max-width: 800px)").matches;
    let next = fitWidthScale(pageWidth, scrollRef.current);
    if (!narrow && projectId) {
      const raw = window.localStorage.getItem(scaleStorageKey(projectId));
      const remembered = raw ? Number(raw) : NaN;
      if (Number.isFinite(remembered)) next = clampScale(remembered);
    }
    fittedRef.current = true;
    setScale(next);
  }, [pageCount, projectId]);

  useEffect(() => {
    if (!projectId || !fittedRef.current) return;
    if (window.matchMedia("(max-width: 800px)").matches) return;
    window.localStorage.setItem(scaleStorageKey(projectId), String(scale));
  }, [projectId, scale]);

  /** Drop the resident PDF immediately — only one document should stay in memory. */
  const dropResidentDoc = () => {
    paintTokenRef.current += 1;
    const prev = docRef.current;
    docRef.current = null;
    pageSizesRef.current = [];
    clearPdfDom(containerRef.current);
    prev?.destroy().catch(() => undefined);
  };

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
  // A recompile keeps the pages on screen until the new file is ready, so the
  // scroll position can be put back on the same page instead of the top.
  useEffect(() => {
    if (!url) {
      pendingAnchorRef.current = null;
      citeLinksRef.current = new Map();
      dropResidentDoc();
      setPageCount(0);
      setPagesReady(false);
      setLoading(false);
      setError(null);
      return;
    }

    const scroller = scrollRef.current;
    const container = containerRef.current;
    if (scroller && container) {
      const anchor = captureScrollAnchor(scroller, container);
      if (anchor) pendingAnchorRef.current = anchor;
    }

    let cancelled = false;
    let settledDoc: PDFDocumentProxy | null = null;
    let loadingTask: ReturnType<typeof pdfjs.getDocument> | null = null;
    const replacing = docRef.current != null;
    if (!replacing) setLoading(true);
    setError(null);

    const prevGate = pdfLoadGate;
    let releaseGate: () => void = () => undefined;
    pdfLoadGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    (async () => {
      try {
        await prevGate;
        if (cancelled) return;
        // Each document owns its worker — see note above on shared workers.
        loadingTask = pdfjs.getDocument({ url });
        const doc = await loadingTask.promise;
        settledDoc = doc;
        if (cancelled) {
          settledDoc = null;
          await doc.destroy().catch(() => undefined);
          return;
        }
        const sizes: Array<{ width: number; height: number }> = [];
        const citeLinks = new Map<number, PdfCiteLink[]>();
        for (let i = 1; i <= doc.numPages; i += 1) {
          const page = await doc.getPage(i);
          try {
            const viewport = page.getViewport({ scale: 1 });
            sizes.push({ width: viewport.width, height: viewport.height });
            const annots = await page.getAnnotations();
            const links: PdfCiteLink[] = [];
            for (const annot of annots) {
              if (annot.subtype !== "Link") continue;
              const citekey = citekeyFromPdfDest(annot.dest);
              const raw = annot.rect;
              if (!citekey || !Array.isArray(raw) || raw.length < 4) continue;
              const rect = [Number(raw[0]), Number(raw[1]), Number(raw[2]), Number(raw[3])];
              if (rect.some((n) => !Number.isFinite(n))) continue;
              links.push({ citekey, rect });
            }
            citeLinks.set(i, links);
          } finally {
            page.cleanup();
          }
        }
        if (cancelled) {
          settledDoc = null;
          await doc.destroy().catch(() => undefined);
          return;
        }
        const previous = docRef.current;
        paintTokenRef.current += 1;
        docRef.current = doc;
        settledDoc = null; // ownership moved to docRef
        citeLinksRef.current = citeLinks;
        pageSizesRef.current = sizes;
        renderedScaleRef.current = scaleRef.current;
        setPagesReady(false);
        setPageCount(doc.numPages);
        setDocVersion((v) => v + 1);
        setError(null);
        // Safe now: previous owned a different worker.
        if (previous && previous !== doc) previous.destroy().catch(() => undefined);
      } catch (err) {
        if (cancelled || isTransientPdfError(err)) return;
        if (!docRef.current) {
          setError(
            err instanceof Error
              ? /missing pdf|unexpected server response|404/i.test(err.message)
                ? "No PDF on this branch yet — click Compile (each branch has its own build)."
                : err.message
              : "Failed to load PDF",
          );
          setPageCount(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      void (async () => {
        try {
          if (loadingTask) await Promise.resolve(loadingTask.destroy()).catch(() => undefined);
          // Leave the current document painted. The next load replaces it, and
          // unmount drops it. Clearing here is what sent the preview back to page 1.
          if (settledDoc) {
            await settledDoc.destroy().catch(() => undefined);
            settledDoc = null;
          }
        } finally {
          releaseGate();
        }
      })();
    };
  }, [url]);

  useEffect(() => {
    return () => {
      dropResidentDoc();
    };
  }, []);

  // Lay out page boxes and paint only those near the viewport (keeps canvas GPU memory bounded).
  useEffect(() => {
    const doc = docRef.current;
    const container = containerRef.current;
    const scroller = scrollRef.current;
    if (!doc || !container || !scroller || pageCount === 0) return;

    let cancelled = false;
    const token = ++paintTokenRef.current;
    const renderScale = scale;
    const sizes = pageSizesRef.current;
    const hadPages = container.querySelector(".pdf-page-wrap") != null;
    const anchor =
      (hadPages ? captureScrollAnchor(scroller, container) : null) ?? pendingAnchorRef.current;
    const inflight = new Map<number, { cancel: () => void }>();
    const painting = new Set<number>();
    const visible = new Set<number>();
    let visibilityFrame: number | null = null;

    const ensureWrap = (pageNum: number, width: number, height: number): HTMLElement => {
      let wrap = container.querySelector(
        `.pdf-page-wrap[data-page="${pageNum}"]`,
      ) as HTMLElement | null;
      if (wrap) {
        wrap.style.width = `${width}px`;
        wrap.style.height = `${height}px`;
        return wrap;
      }
      wrap = document.createElement("div");
      wrap.className = "pdf-page-wrap is-placeholder";
      wrap.dataset.page = String(pageNum);
      wrap.style.width = `${width}px`;
      wrap.style.height = `${height}px`;
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page";
      canvas.dataset.page = String(pageNum);
      canvas.style.display = "none";
      canvas.title = citationClickRef.current
        ? "Click a citation → library · Click elsewhere → source · Shift+click → comment"
        : "Click → source · Shift+click → comment";
      const clientToPdf = (ev: MouseEvent, target: HTMLElement) => {
        const rect = target.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const currentScale = scaleRef.current;
        const x = ((ev.clientX - rect.left) / rect.width) * (target.offsetWidth / currentScale);
        const y = ((ev.clientY - rect.top) / rect.height) * (target.offsetHeight / currentScale);
        return { x, y, rect };
      };

      let dragStart: { x: number; y: number } | null = null;
      let dragBand: HTMLElement | null = null;
      let didDrag = false;

      wrap.addEventListener("mousedown", (ev) => {
        const mode = modeRef.current;
        // "text" uses the selectable text layer — don't steal the drag.
        if (mode !== "highlight" && mode !== "underline" && mode !== "area") return;
        if (ev.button !== 0) return;
        const target = ev.currentTarget as HTMLElement;
        const pt = clientToPdf(ev, target);
        if (!pt) return;
        ev.preventDefault();
        dragStart = { x: pt.x, y: pt.y };
        didDrag = false;
        dragBand?.remove();
        dragBand = document.createElement("div");
        dragBand.className = "pdf-ann-drag";
        dragBand.style.left = `${ev.clientX - pt.rect.left}px`;
        dragBand.style.top = `${ev.clientY - pt.rect.top}px`;
        dragBand.style.width = "0px";
        dragBand.style.height = "0px";
        target.appendChild(dragBand);
      });

      wrap.addEventListener("mousemove", (ev) => {
        if (!dragStart && modeRef.current === "sync") {
          const target = ev.currentTarget as HTMLElement;
          const pt = clientToPdf(ev, target);
          const pageHeight = target.offsetHeight / scaleRef.current;
          const citekey =
            pt && citationClickRef.current
              ? citationLinkAtPoint(citeLinksRef.current.get(pageNum) ?? [], pt.x, pt.y, pageHeight)
              : null;
          target.classList.toggle("is-cite-link", Boolean(citekey));
        }
        if (!dragStart || !dragBand) return;
        const target = ev.currentTarget as HTMLElement;
        const pt = clientToPdf(ev, target);
        if (!pt) return;
        const currentScale = scaleRef.current;
        const x0 = Math.min(dragStart.x, pt.x);
        const y0 = Math.min(dragStart.y, pt.y);
        const x1 = Math.max(dragStart.x, pt.x);
        const y1 = Math.max(dragStart.y, pt.y);
        if (Math.abs(x1 - x0) > 3 || Math.abs(y1 - y0) > 3) didDrag = true;
        dragBand.style.left = `${x0 * currentScale}px`;
        dragBand.style.top = `${y0 * currentScale}px`;
        dragBand.style.width = `${(x1 - x0) * currentScale}px`;
        dragBand.style.height = `${(y1 - y0) * currentScale}px`;
      });

      const endDrag = (ev: MouseEvent) => {
        if (!dragStart) return;
        const target = ev.currentTarget as HTMLElement;
        const pt = clientToPdf(ev, target);
        const start = dragStart;
        dragStart = null;
        dragBand?.remove();
        dragBand = null;
        if (!pt || !didDrag) return;
        const x = Math.min(start.x, pt.x);
        const y = Math.min(start.y, pt.y);
        const w = Math.abs(pt.x - start.x);
        const h = Math.abs(pt.y - start.y);
        if (w < 4 || h < 4) return;
        areaSelectRef.current?.({ page: pageNum, x, y, w, h });
      };
      wrap.addEventListener("mouseup", (ev) => {
        endDrag(ev);
        if (modeRef.current !== "text" || !textSelectRef.current) return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return;
        const target = ev.currentTarget as HTMLElement;
        if (!target.contains(sel.anchorNode) && !target.contains(sel.focusNode)) return;
        const quote = sel.toString().replace(/\s+/g, " ").trim();
        if (quote.length < 1) return;
        const range = sel.getRangeAt(0);
        const r = range.getBoundingClientRect();
        const wrapRect = target.getBoundingClientRect();
        if (wrapRect.width <= 0 || wrapRect.height <= 0) return;
        const currentScale = scaleRef.current;
        const x = ((r.left - wrapRect.left) / wrapRect.width) * (target.offsetWidth / currentScale);
        const y = ((r.top - wrapRect.top) / wrapRect.height) * (target.offsetHeight / currentScale);
        const w = (r.width / wrapRect.width) * (target.offsetWidth / currentScale);
        const h = (r.height / wrapRect.height) * (target.offsetHeight / currentScale);
        if (w < 2 || h < 2) return;
        textSelectRef.current({ page: pageNum, x, y, w, h, quote });
        sel.removeAllRanges();
      });
      wrap.addEventListener("mouseleave", (ev) => {
        (ev.currentTarget as HTMLElement).classList.remove("is-cite-link");
        if (dragStart) endDrag(ev);
      });

      wrap.addEventListener("click", (ev) => {
        if (didDrag) {
          didDrag = false;
          return;
        }
        const target = ev.currentTarget as HTMLElement;
        const pt = clientToPdf(ev, target);
        if (!pt) return;
        const { x, y, rect } = pt;

        target.querySelectorAll(".pdf-click-pulse").forEach((el) => el.remove());
        const pulse = document.createElement("div");
        pulse.className = "pdf-click-pulse";
        pulse.style.left = `${ev.clientX - rect.left - 10}px`;
        pulse.style.top = `${ev.clientY - rect.top - 10}px`;
        target.appendChild(pulse);
        window.setTimeout(() => pulse.remove(), 700);

        const mode = modeRef.current;
        if (mode === "pin") {
          commentRef.current?.(pageNum, x, y);
          return;
        }
        if (mode === "highlight" || mode === "underline" || mode === "area") {
          // Click without drag: treat as a small pin-sized area for convenience.
          if (ev.shiftKey) {
            commentRef.current?.(pageNum, x, y);
          }
          return;
        }

        if (ev.shiftKey && commentRef.current) {
          commentRef.current(pageNum, x, y);
          return;
        }
        const pageHeight = target.offsetHeight / scaleRef.current;
        const citekey = citationClickRef.current
          ? citationLinkAtPoint(citeLinksRef.current.get(pageNum) ?? [], x, y, pageHeight)
          : null;
        if (citekey && citationClickRef.current) {
          citationClickRef.current(citekey);
          return;
        }
        reverseRef.current?.(pageNum, x, y);
      });
      wrap.appendChild(canvas);
      container.appendChild(wrap);
      return wrap;
    };

    for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
      const size = sizes[pageNum - 1];
      const width = (size?.width ?? 612) * renderScale;
      const height = (size?.height ?? 792) * renderScale;
      ensureWrap(pageNum, width, height);
    }
    for (const node of [...container.querySelectorAll(".pdf-page-wrap")]) {
      const pageNum = Number((node as HTMLElement).dataset.page);
      if (!pageNum || pageNum > pageCount) node.remove();
    }

    if (scroller) restoreScrollAnchor(scroller, container, anchor);
    if (anchor) pendingAnchorRef.current = anchor;
    let scrollFrame: number | null = null;
    if (anchor) {
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = null;
        if (cancelled || token !== paintTokenRef.current) return;
        restoreScrollAnchor(scroller, container, anchor);
      });
    }
    renderedScaleRef.current = renderScale;
    setPagesReady(true);

    const releasePageCanvas = (pageNum: number) => {
      const wrap = container.querySelector(
        `.pdf-page-wrap[data-page="${pageNum}"]`,
      ) as HTMLElement | null;
      const canvas = wrap?.querySelector("canvas") as HTMLCanvasElement | null;
      if (canvas) {
        releaseCanvas(canvas);
        canvas.style.display = "none";
      }
      wrap?.classList.add("is-placeholder");
    };

    const hasRenderableViewport = () => {
      const rect = scroller.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        scroller.clientWidth > 0 &&
        scroller.clientHeight > 0
      );
    };

    const isCancelledRender = (err: unknown): boolean => {
      if (cancelled || token !== paintTokenRef.current) return true;
      if (isTransientPdfError(err)) return true;
      const name = err && typeof err === "object" && "name" in err ? String(err.name) : "";
      const message = err instanceof Error ? err.message : String(err ?? "");
      return (
        name === "RenderingCancelledException" ||
        message.includes("Rendering cancelled") ||
        message.includes("Cannot use the same canvas")
      );
    };

    const paint = async (pageNum: number) => {
      if (cancelled || token !== paintTokenRef.current) return;
      if (!hasRenderableViewport()) {
        visible.delete(pageNum);
        releasePageCanvas(pageNum);
        return;
      }
      if (painting.has(pageNum)) return;
      painting.add(pageNum);
      const wrap = container.querySelector(
        `.pdf-page-wrap[data-page="${pageNum}"]`,
      ) as HTMLElement | null;
      const canvas = wrap?.querySelector("canvas") as HTMLCanvasElement | null;
      if (!wrap || !canvas) {
        painting.delete(pageNum);
        return;
      }
      let page: Awaited<ReturnType<PDFDocumentProxy["getPage"]>> | null = null;
      let rendered = false;
      let retryVisible = false;
      try {
        page = await doc.getPage(pageNum);
        if (
          cancelled ||
          token !== paintTokenRef.current ||
          !visible.has(pageNum) ||
          !hasRenderableViewport()
        ) {
          return;
        }
        const viewport = page.getViewport({ scale: renderScale });
        wrap.style.width = `${viewport.width}px`;
        wrap.style.height = `${viewport.height}px`;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.display = "block";
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const task = page.render({ canvasContext: ctx, viewport });
        inflight.set(pageNum, task);
        await task.promise;
        if (cancelled || token !== paintTokenRef.current) return;
        if (!visible.has(pageNum)) {
          releasePageCanvas(pageNum);
          return;
        }
        wrap.classList.remove("is-placeholder");
        // Selectable text layer for fact tagging (mode "text").
        wrap.querySelector(".pdf-text-layer")?.remove();
        if (modeRef.current === "text" && page) {
          try {
            const content = await page.getTextContent();
            const layer = document.createElement("div");
            layer.className = "pdf-text-layer";
            for (const raw of content.items) {
              if (!("str" in raw) || typeof raw.str !== "string" || !raw.str) continue;
              const tr = pdfjs.Util.transform(viewport.transform, raw.transform);
              const fontH = Math.hypot(tr[2], tr[3]) || 10;
              const span = document.createElement("span");
              span.textContent = raw.str;
              span.style.left = `${tr[4]}px`;
              span.style.top = `${tr[5] - fontH}px`;
              span.style.fontSize = `${fontH}px`;
              span.style.fontFamily = "sans-serif";
              layer.appendChild(span);
              if (raw.hasEOL) layer.appendChild(document.createElement("br"));
            }
            wrap.appendChild(layer);
          } catch {
            /* text layer is best-effort */
          }
        }
        rendered = true;
      } catch (err) {
        if (isCancelledRender(err)) {
          retryVisible =
            !cancelled &&
            token === paintTokenRef.current &&
            visible.has(pageNum);
          return;
        }
        if (!cancelled && token === paintTokenRef.current && !isTransientPdfError(err)) {
          setError(err instanceof Error ? err.message : "Failed to render PDF page");
        }
      } finally {
        inflight.delete(pageNum);
        painting.delete(pageNum);
        if (!rendered) releasePageCanvas(pageNum);
        page?.cleanup();
        // A page can leave and re-enter while its cancelled render settles.
        // The visibility callback cannot restart it while `painting` is set.
        if (retryVisible) queueMicrotask(() => void paint(pageNum));
      }
    };

    const hidePage = (pageNum: number) => {
      visible.delete(pageNum);
      inflight.get(pageNum)?.cancel();
      if (!painting.has(pageNum)) releasePageCanvas(pageNum);
    };

    const refreshVisiblePages = () => {
      if (cancelled || token !== paintTokenRef.current) return;
      const rootRect = scroller.getBoundingClientRect();

      // A narrow-layout pane uses display:none. All of its page rectangles are
      // then zeroes, which used to make the fallback below classify every page
      // as visible and render the whole PDF into hidden canvases.
      if (
        rootRect.width <= 0 ||
        rootRect.height <= 0 ||
        scroller.clientWidth <= 0 ||
        scroller.clientHeight <= 0
      ) {
        for (const wrap of [...container.querySelectorAll(".pdf-page-wrap")] as HTMLElement[]) {
          const pageNum = Number(wrap.dataset.page);
          if (pageNum) hidePage(pageNum);
        }
        return;
      }

      const margin = Math.max(rootRect.height, 1) * 1.4;
      for (const wrap of [...container.querySelectorAll(".pdf-page-wrap")] as HTMLElement[]) {
        const rect = wrap.getBoundingClientRect();
        const pageNum = Number(wrap.dataset.page);
        if (!pageNum) continue;
        const near =
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom >= rootRect.top - margin &&
          rect.top <= rootRect.bottom + margin;
        if (near) {
          visible.add(pageNum);
          void paint(pageNum);
        } else {
          hidePage(pageNum);
        }
      }
    };

    const scheduleVisibilityRefresh = () => {
      if (visibilityFrame != null) return;
      visibilityFrame = window.requestAnimationFrame(() => {
        visibilityFrame = null;
        refreshVisiblePages();
      });
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNum = Number((entry.target as HTMLElement).dataset.page);
          if (!pageNum) continue;
          if (entry.isIntersecting) {
            visible.add(pageNum);
            void paint(pageNum);
          } else {
            hidePage(pageNum);
          }
        }
      },
      { root: scroller, rootMargin: "140% 0px", threshold: 0 },
    );

    for (const wrap of container.querySelectorAll(".pdf-page-wrap")) {
      observer.observe(wrap);
    }

    // ResizeObserver fires when mobile pane CSS hides/reveals the preview and
    // when split-pane resizing changes the set of nearby pages.
    const resizeObserver = new ResizeObserver(scheduleVisibilityRefresh);
    resizeObserver.observe(scroller);
    scheduleVisibilityRefresh();

    return () => {
      cancelled = true;
      if (scrollFrame != null) window.cancelAnimationFrame(scrollFrame);
      if (visibilityFrame != null) window.cancelAnimationFrame(visibilityFrame);
      resizeObserver.disconnect();
      observer.disconnect();
      for (const task of inflight.values()) task.cancel();
      inflight.clear();
      // Release painted bitmaps when scale/doc changes; placeholders stay until
      // the next layout pass rebuilds wraps.
      container.querySelectorAll("canvas").forEach((node) => {
        releaseCanvas(node as HTMLCanvasElement);
      });
    };
  }, [docVersion, scale, pageCount]);

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

  // SyncTeX / fact flash — wait until page wraps exist; retry after load.
  useEffect(() => {
    if (!flash || !containerRef.current || loading || !pagesReady) return;
    let cancelled = false;
    let tries = 0;

    const paint = (): boolean => {
      const container = containerRef.current;
      if (!container || cancelled) return false;
      const wrap = container.querySelector(
        `.pdf-page-wrap[data-page="${flash.page}"]`,
      ) as HTMLElement | null;
      if (!wrap) return false;

      container.querySelectorAll(".pdf-sync-mark, .pdf-sync-label").forEach((el) => el.remove());

      const pageW = wrap.clientWidth;
      const pageH = wrap.clientHeight;
      const vertical = Boolean(flash.fullHeight);
      // SyncTeX / fact boxes are often hairline-thin; paint a readable band instead.
      let left: number;
      let top: number;
      let width: number;
      let h: number;
      if (vertical) {
        // Tight column on the cell ink — no tall page band (imprecise for 90° tables).
        const cellW = Math.max((flash.width ?? 14) * scale, 1);
        const cellH = Math.max((flash.height ?? 24) * scale, 1);
        width = Math.max(cellW + 4, 12);
        left = Math.max(0, flash.x * scale + cellW / 2 - width / 2);
        top = Math.max(0, flash.y * scale - 3);
        h = Math.min(pageH - top, Math.max(cellH + 6, 14));
      } else if (flash.fullWidth !== false) {
        const synctexH = Math.max((flash.height ?? 12) * scale, 1);
        h = Math.max(synctexH * 1.35, 26 * Math.min(scale, 1.4));
        top = Math.max(0, flash.y * scale - h * 0.55);
        left = pageW * 0.05;
        width = pageW * 0.9;
      } else {
        // Table / fact cell: hug the number bbox.
        const cellW = Math.max((flash.width ?? 40) * scale, 1);
        const cellH = Math.max((flash.height ?? 12) * scale, 1);
        left = Math.max(0, flash.x * scale - 3);
        top = Math.max(0, flash.y * scale - 2);
        width = Math.max(cellW + 6, 18);
        h = Math.max(cellH + 4, 12);
      }

      const mark = document.createElement("div");
      mark.className = `pdf-sync-mark${vertical ? " is-vertical" : ""}`;
      mark.style.left = `${left}px`;
      mark.style.top = `${top}px`;
      mark.style.width = `${width}px`;
      mark.style.height = `${h}px`;
      wrap.appendChild(mark);

      if (flash.label) {
        const label = document.createElement("div");
        label.className = `pdf-sync-label${vertical ? " is-vertical" : ""}`;
        label.textContent = flash.label;
        if (vertical) {
          label.style.left = `${Math.min(pageW - 120, left + width + 6)}px`;
          label.style.top = `${Math.max(0, flash.y * scale - 4)}px`;
        } else {
          label.style.left = `${left}px`;
          label.style.top = `${Math.max(0, top - 26)}px`;
        }
        wrap.appendChild(label);
      }

      const flashKey = flash.nonce ?? flash.page * 1e9 + flash.x * 1e3 + flash.y;
      if (scrolledFlashNonceRef.current === flashKey) return true;
      scrolledFlashNonceRef.current = flashKey;

      // Center the mark in the PDF scroller (not the page top). Avoid scrollIntoView —
      // it races nested scroll parents and leaves the hit under the toolbar/meta.
      const scroller = scrollRef.current;
      if (scroller) {
        const centerMark = () => {
          const markRect = mark.getBoundingClientRect();
          const scrollerRect = scroller.getBoundingClientRect();
          if (markRect.height <= 0 || scrollerRect.height <= 0) return;
          const markMid = markRect.top + markRect.height / 2;
          const viewMid = scrollerRect.top + scrollerRect.height / 2;
          const nextTop = scroller.scrollTop + (markMid - viewMid);
          const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          scroller.scrollTo({ top: Math.min(maxTop, Math.max(0, nextTop)), behavior: "smooth" });
        };
        requestAnimationFrame(() => requestAnimationFrame(centerMark));
      }
      return true;
    };

    if (paint()) return;

    const timer = window.setInterval(() => {
      tries += 1;
      if (paint() || tries >= 40) window.clearInterval(timer);
    }, 50);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [flash, scale, pageCount, loading, pagesReady, docVersion]);

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

  // Persistent library/project annotation marks.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.querySelectorAll(".pdf-ann-layer").forEach((el) => el.remove());
    if (!annotations?.length || !pagesReady || loading) return;

    const byPage = new Map<number, PdfAnnotationMark[]>();
    for (const ann of annotations) {
      if (!ann.page || ann.page < 1) continue;
      const list = byPage.get(ann.page) ?? [];
      list.push(ann);
      byPage.set(ann.page, list);
    }

    for (const [page, marks] of byPage) {
      const wrap = container.querySelector(
        `.pdf-page-wrap[data-page="${page}"]`,
      ) as HTMLElement | null;
      if (!wrap) continue;
      const layer = document.createElement("div");
      layer.className = "pdf-ann-layer";
      for (const ann of marks) {
        const color = ann.color || "#facc15";
        const rects =
          ann.rects && ann.rects.length
            ? ann.rects
            : ann.w != null && ann.h != null
              ? [{ x: ann.x, y: ann.y, w: ann.w, h: ann.h }]
              : [{ x: ann.x, y: ann.y, w: ann.w ?? 14, h: ann.h ?? 14 }];

        if (ann.kind === "pin" || ann.kind === "note") {
          const pin = document.createElement("button");
          pin.type = "button";
          pin.className = `pdf-ann-pin${ann.selected ? " is-selected" : ""}`;
          pin.style.left = `${ann.x * scale}px`;
          pin.style.top = `${ann.y * scale}px`;
          pin.style.setProperty("--ann-color", color);
          pin.title = ann.label || "Annotation";
          pin.addEventListener("click", (ev) => {
            ev.stopPropagation();
            annClickRef.current?.(ann.id);
          });
          layer.appendChild(pin);
          continue;
        }

        for (const r of rects) {
          const el = document.createElement("button");
          el.type = "button";
          el.className = `pdf-ann-mark pdf-ann-${ann.kind}${ann.selected ? " is-selected" : ""}`;
          el.style.left = `${r.x * scale}px`;
          el.style.top = `${r.y * scale}px`;
          el.style.width = `${Math.max(r.w * scale, 4)}px`;
          el.style.height = `${Math.max(r.h * scale, ann.kind === "underline" ? 3 : 4)}px`;
          el.style.setProperty("--ann-color", color);
          el.title = ann.label || "Annotation";
          el.addEventListener("click", (ev) => {
            ev.stopPropagation();
            annClickRef.current?.(ann.id);
          });
          layer.appendChild(el);
        }
      }
      wrap.appendChild(layer);
    }
  }, [annotations, scale, pagesReady, loading, docVersion]);

  // Report the page centered in the viewport (for sidebar page filter).
  useEffect(() => {
    const scroller = scrollRef.current;
    const container = containerRef.current;
    if (!scroller || !container || !onVisiblePageChange) return;

    let last = 0;
    const report = () => {
      const anchor = captureScrollAnchor(scroller, container);
      if (!anchor || anchor.page === last) return;
      last = anchor.page;
      visiblePageRef.current?.(anchor.page);
    };
    report();
    scroller.addEventListener("scroll", report, { passive: true });
    return () => scroller.removeEventListener("scroll", report);
  }, [onVisiblePageChange, pagesReady, pageCount, docVersion]);

  // Cursor hint for annotate modes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.dataset.annMode = interactionMode;
  }, [interactionMode, pagesReady, docVersion]);

  // Build / tear down selectable text layers when entering "text" mode.
  useEffect(() => {
    const container = containerRef.current;
    const doc = docRef.current;
    if (!container) return;
    if (interactionMode !== "text") {
      container.querySelectorAll(".pdf-text-layer").forEach((n) => n.remove());
      return;
    }
    let cancelled = false;
    void (async () => {
      for (const wrap of [...container.querySelectorAll(".pdf-page-wrap")] as HTMLElement[]) {
        if (cancelled || wrap.classList.contains("is-placeholder")) continue;
        if (wrap.querySelector(".pdf-text-layer")) continue;
        const pageNum = Number(wrap.dataset.page);
        if (!doc || !pageNum) continue;
        try {
          const page = await doc.getPage(pageNum);
          if (cancelled) {
            page.cleanup();
            return;
          }
          const viewport = page.getViewport({ scale: scaleRef.current });
          const content = await page.getTextContent();
          const layer = document.createElement("div");
          layer.className = "pdf-text-layer";
          for (const raw of content.items) {
            if (!("str" in raw) || typeof raw.str !== "string" || !raw.str) continue;
            const tr = pdfjs.Util.transform(viewport.transform, raw.transform);
            const fontH = Math.hypot(tr[2], tr[3]) || 10;
            const span = document.createElement("span");
            span.textContent = raw.str;
            span.style.left = `${tr[4]}px`;
            span.style.top = `${tr[5] - fontH}px`;
            span.style.fontSize = `${fontH}px`;
            span.style.fontFamily = "sans-serif";
            layer.appendChild(span);
            if (raw.hasEOL) layer.appendChild(document.createElement("br"));
          }
          wrap.appendChild(layer);
          page.cleanup();
        } catch {
          /* ignore */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [interactionMode, pagesReady, docVersion, scale]);

  return (
    <div
      className={`pane pdf-pane${fullscreen ? " pdf-pane--fullscreen" : ""}`}
      style={{ height: "100%" }}
    >
      {staleBanner ? <div className="pdf-stale-banner">{staleBanner}</div> : null}
      <div className="pdf-toolbar">
        <span className="pane-title" style={{ padding: 0 }}>
          PDF
        </span>
        {shiftClickHint !== null ? (
          <span
            className="status-pill pdf-comment-hint"
            title={
              shiftClickHint ??
              "Shift+click anywhere in the PDF to start a comment at the matching source line"
            }
          >
            {shiftClickHint ?? "Shift+click → comment"}
          </span>
        ) : null}
        {diffHighlight && (
          <div className="pdf-diff-controls">
            <button
              type="button"
              className={`btn btn-ghost${diffHighlight.enabled ? " pdf-diff-toggle-on" : ""}`}
              aria-pressed={diffHighlight.enabled}
              title="Show differences between what you’re viewing and a baseline leaf on the timeline"
              onClick={() => diffHighlight.onEnabledChange(!diffHighlight.enabled)}
            >
              {diffHighlight.enabled ? "Differences on" : "Differences"}
            </button>
            {diffHighlight.enabled && (
              <>
                <button
                  type="button"
                  className="btn btn-ghost pdf-diff-compare-btn"
                  title="Pick a timeline leaf to compare against"
                  onClick={() => diffHighlight.onPickBaseline()}
                >
                  <span className="pdf-diff-compare-kicker">Compare to</span>
                  <span className="pdf-diff-compare-label">
                    {diffHighlight.baselineLabel ||
                      (diffHighlight.baselineHash
                        ? diffHighlight.baselineHash.slice(0, 7)
                        : "Pick a leaf…")}
                  </span>
                </button>
                {diffHighlight.markupPdf?.available && (
                  <button
                    type="button"
                    className={`btn btn-ghost${diffHighlight.markupPdf.enabled ? " pdf-diff-markup-on" : ""}`}
                    aria-pressed={diffHighlight.markupPdf.enabled}
                    title="Experimental: replace the preview with a latexdiff track-changes PDF of the compare baseline vs this checkpoint. Uncommitted editor edits are not included."
                    onClick={() =>
                      diffHighlight.markupPdf?.onEnabledChange(!diffHighlight.markupPdf.enabled)
                    }
                  >
                    {diffHighlight.markupPdf.loading
                      ? "Building markup PDF…"
                      : diffHighlight.markupPdf.enabled
                        ? "Markup PDF on"
                        : "Markup PDF"}
                    <span className="pdf-diff-exp">exp</span>
                  </button>
                )}
                <span
                  className="status-pill pdf-diff-stat"
                  title={
                    diffHighlight.warning ??
                    (diffHighlight.markupPdf?.enabled
                      ? "Preview is the latexdiff track-changes PDF (committed checkpoints only)."
                      : "Editor: +/− line decorations. PDF: SyncTeX boxes for added .tex lines on the live tip.")
                  }
                >
                  {diffHighlight.loading
                    ? "…"
                    : diffHighlight.additions != null && diffHighlight.deletions != null
                      ? (
                          <>
                            <span className="pdf-diff-stat-add">
                              +{diffHighlight.additions}
                            </span>
                            <span className="pdf-diff-stat-del">
                              −{diffHighlight.deletions}
                            </span>
                            {diffHighlight.fileCount != null && diffHighlight.fileCount > 0
                              ? ` · ${diffHighlight.fileCount} file${diffHighlight.fileCount === 1 ? "" : "s"}`
                              : ""}
                          </>
                        )
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
      {!url && (
        <div className="empty-hint empty-hint-card pdf-empty">
          <strong>{emptyHint ? "PDF not ready" : "No PDF yet"}</strong>
          <p>{emptyHint || "Compile the project to build a preview for this branch."}</p>
        </div>
      )}
      {loading && pageCount === 0 && <div className="empty-hint">Loading PDF…</div>}
      {error && !isTransientPdfErrorMessage(error) ? (
        <ErrorBanner style={{ margin: "1rem" }} onDismiss={() => setError(null)}>
          {error}
        </ErrorBanner>
      ) : null}
      <div className="pdf-scroll" ref={scrollRef}>
        <div ref={containerRef} />
      </div>
    </div>
  );
}
