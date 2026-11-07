import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { Link } from "react-router-dom";
import {
  bulkPatchLibraryPapers,
  checkLibraryIntegrity,
  checkLibraryPaperIntegrity,
  checkProjectCitations,
  createLibraryCollection,
  createLibraryPaper,
  deleteLibraryPaper,
  enrichLibrary,
  enrichLibraryPaper,
  exportLibraryPapers,
  fetchLibraryPdf,
  getLibraryCollections,
  getLibraryHostPath,
  getLibraryPaper,
  getLibraryPdfSource,
  importLibraryBibtex,
  importLibraryLink,
  importLibraryPdf,
  importLibraryWeb,
  listLibraryPapers,
  patchLibraryPaper,
  type CitationInstance,
  type LibraryPdfSourceHint,
} from "../api/client";
import type { LibraryCollections, LibrarySort, PaperRecord } from "../api/types";
import { listLibraryAiLinks } from "../api/libraryAi";
import { copyText } from "../lib/clipboard";
import { clientOs } from "../lib/hostPath";
import { readLastProject } from "../lib/lastProject";
import { isTransientPdfErrorMessage } from "../lib/transientErrors";
import {
  isPdfFile,
  previewPdfReplace,
  uploadPaperPdf,
  type PdfReplacePreview,
} from "../lib/libraryPdfUpload";
import {
  TOPIC_SUGGESTIONS,
  SORT_OPTIONS,
  normalizePaper,
  ratingStars,
  slugCollectionId,
} from "./LibraryOrganize";
import { ErrorBanner } from "./ErrorBanner";
import { LibraryAiLinkPanel } from "./LibraryAiLinkPanel";
import { LibraryAiReviewPanel } from "./LibraryAiReviewPanel";
import { LibraryPdfNotes } from "./LibraryPdfNotes";
import { LibrarySharePanel } from "./LibrarySharePanel";
import { SplitPane } from "./SplitPane";

function downloadTextFile(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Cheap list-row PDF affordance (no network). */
function pdfListHint(p: PaperRecord): "local" | "arxiv" | null {
  if (p.attachment) return "local";
  if (p.arxivId?.trim()) return "arxiv";
  if (p.doi && /^10\.48550\/arxiv\./i.test(p.doi)) return "arxiv";
  return null;
}

type Props = {
  open: boolean;
  onClose: () => void;
  /** drawer = editor overlay; page = full-screen route (no project required). */
  variant?: "drawer" | "page";
  projectId?: string;
  /** Select this citekey once the catalog loads (library page deep link). */
  focusCitekey?: string | null;
  onCiteIntoProject?: (citekey: string) => void;
  onCitationsChanged?: (instances: CitationInstance[]) => void;
};

type Density = "compact" | "comfortable";

function isWebSource(paper: PaperRecord): boolean {
  return paper.source === "web" || Boolean(paper.url && !paper.doi && !paper.arxivId);
}

function phoneMeta(paper: PaperRecord): string {
  if (isWebSource(paper)) {
    return ["Web page", paper.year != null ? String(paper.year) : ""].filter(Boolean).join(" · ");
  }
  const first = paper.authors[0];
  const who = !first
    ? "Unknown author"
    : paper.authors.length > 1
      ? `${first.family} et al.`
      : first.family;
  return [who, paper.year != null ? String(paper.year) : "", paper.venue].filter(Boolean).join(" · ");
}

function authorsLabel(paper: PaperRecord, opts?: { compact?: boolean }): string {
  if (isWebSource(paper) && !paper.authors.length) return "Web page";
  if (!paper.authors.length) return "Unknown authors";
  if (opts?.compact) {
    const first = paper.authors[0]!;
    return paper.authors.length > 1 ? `${first.family} et al.` : first.family;
  }
  return paper.authors
    .map((a) => (a.given ? `${a.family}, ${a.given}` : a.family))
    .join("; ");
}

function integrityBadge(paper: PaperRecord): { label: string; className: string } {
  if (paper.integrity.retraction === "retracted") {
    return { label: "Retracted", className: "lib-badge lib-badge-bad" };
  }
  if (paper.integrity.retraction === "corrected") {
    return { label: "Corrected", className: "lib-badge lib-badge-warn" };
  }
  if (paper.integrity.existence === "verified") {
    return { label: "Verified", className: "lib-badge lib-badge-ok" };
  }
  if (paper.integrity.existence === "mismatch") {
    return { label: "Mismatch", className: "lib-badge lib-badge-warn" };
  }
  if (paper.integrity.reason?.trim()) {
    return { label: "Explained", className: "lib-badge lib-badge-warn" };
  }
  // Web pages are not Crossref-checked — "Unchecked" is meaningless there.
  if (isWebSource(paper)) {
    return { label: "Web snapshot", className: "lib-badge" };
  }
  return { label: "Unchecked", className: "lib-badge" };
}

function collectionNames(paper: PaperRecord, collections: LibraryCollections | null): string[] {
  if (!collections) return paper.collections;
  return paper.collections.map((id) => collections.collections[id]?.name ?? id);
}

export function LibraryPanel({
  open,
  onClose,
  variant = "drawer",
  projectId,
  focusCitekey = null,
  onCiteIntoProject,
  onCitationsChanged,
}: Props) {
  const [papers, setPapers] = useState<PaperRecord[]>([]);
  const [collections, setCollections] = useState<LibraryCollections | null>(null);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [collectionFilter, setCollectionFilter] = useState<string | null>(null);
  const [starredOnly, setStarredOnly] = useState(false);
  const [sort, setSort] = useState<LibrarySort>("added");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set());
  const [density, setDensity] = useState<Density>(() => (variant === "page" ? "compact" : "comfortable"));
  const [toolsOpen, setToolsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [aiLinkOpen, setAiLinkOpen] = useState(false);
  const [aiReviewOpen, setAiReviewOpen] = useState(false);
  const [aiPendingCount, setAiPendingCount] = useState(0);
  const [pdfHint, setPdfHint] = useState<LibraryPdfSourceHint | null>(null);
  const [viewMode, setViewMode] = useState<"browse" | "litreview">("browse");
  const [focusFactId, setFocusFactId] = useState<string | null>(null);
  const [litRows, setLitRows] = useState<
    Array<{ paper: PaperRecord; relevance: string; claim: string; integrity: string; importSelected: boolean }>
  >([]);
  const [importLink, setImportLink] = useState("");
  const [importBib, setImportBib] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detailPdfDrag, setDetailPdfDrag] = useState(false);
  const [pdfReplacePrompt, setPdfReplacePrompt] = useState<PdfReplacePreview | null>(null);
  const [pdfRevision, setPdfRevision] = useState(0);
  const detailDragDepth = useRef(0);
  const [catalogReady, setCatalogReady] = useState(false);
  const appliedFocusRef = useRef<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [newCollectionName, setNewCollectionName] = useState("");
  const [sectionOpen, setSectionOpen] = useState({
    info: true,
    organize: true,
    notes: true,
    pdf: true,
    tags: true,
    integrity: true,
  });
  const [phoneMenu, setPhoneMenu] = useState(false);
  const [phoneSearch, setPhoneSearch] = useState(false);
  const [phoneSheet, setPhoneSheet] = useState<null | "collections" | "topics" | "sort">(null);
  const [selecting, setSelecting] = useState(false);
  const [detailMenu, setDetailMenu] = useState(false);
  const [pathMenu, setPathMenu] = useState<{ x: number; y: number; citekey: string; hasPdf: boolean } | null>(null);
  const [pathBanner, setPathBanner] = useState<{ ok: boolean; path: string } | null>(null);
  const pressTimer = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const masterSplitRef = useRef<HTMLDivElement>(null);
  const sidebarWidthRef = useRef(220);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem("openleaf.library.sidebarWidth"));
    return !Number.isNaN(saved) && saved >= 160 && saved <= 420 ? saved : 220;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("openleaf.library.sidebarCollapsed") === "1",
  );
  const [sidebarDragging, setSidebarDragging] = useState(false);

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  useEffect(() => {
    if (!sidebarDragging || sidebarCollapsed) return;
    const onMove = (e: PointerEvent) => {
      const el = masterSplitRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const w = Math.min(420, Math.max(160, e.clientX - rect.left));
      sidebarWidthRef.current = w;
      setSidebarWidth(w);
    };
    const onUp = () => {
      setSidebarDragging(false);
      localStorage.setItem("openleaf.library.sidebarWidth", String(sidebarWidthRef.current));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [sidebarDragging, sidebarCollapsed]);

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("openleaf.library.sidebarCollapsed", next ? "1" : "0");
      return next;
    });
  }, []);

  const copyLibraryPath = useCallback(async (citekey: string, kind: "pdf" | "folder") => {
    setPathMenu(null);
    try {
      const result = await getLibraryHostPath(citekey, { os: clientOs(), kind });
      const ok = await copyText(result.path);
      setPathBanner({ ok, path: result.path });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not copy the path");
    }
  }, []);

  useEffect(() => {
    if (!pathMenu) return;
    const close = () => setPathMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPathMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [pathMenu]);

  const upsertLocal = useCallback((updated: PaperRecord) => {
    const norm = normalizePaper(updated);
    setPapers((prev) => prev.map((p) => (p.citekey === norm.citekey ? norm : p)));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [{ papers: list }, coll] = await Promise.all([
        listLibraryPapers({
          q: query || undefined,
          tag: tagFilter ?? undefined,
          collection: collectionFilter ?? undefined,
          starred: starredOnly ? true : undefined,
          sort,
          limit: 2000,
        }),
        getLibraryCollections(),
      ]);
      setPapers(list.map(normalizePaper));
      setCollections(coll);
      setCatalogReady(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load library");
    }
  }, [query, tagFilter, collectionFilter, starredOnly, sort]);

  useEffect(() => {
    if (variant !== "page") return;
    let last = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      if (y > last + 8 && y > 48) document.documentElement.dataset.libraryBar = "hidden";
      else if (y < last - 8 || y < 16) delete document.documentElement.dataset.libraryBar;
      last = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      delete document.documentElement.dataset.libraryBar;
    };
  }, [variant]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    if (focusCitekey) return;
    const t = window.setTimeout(() => searchRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open, refresh, focusCitekey]);

  useEffect(() => {
    if (!open || !focusCitekey || !catalogReady) return;
    if (appliedFocusRef.current === focusCitekey) return;
    if (papers.some((p) => p.citekey === focusCitekey)) {
      appliedFocusRef.current = focusCitekey;
      setSelectedKey(focusCitekey);
      return;
    }
    let cancelled = false;
    void getLibraryPaper(focusCitekey)
      .then((paper) => {
        if (cancelled) return;
        const norm = normalizePaper(paper);
        appliedFocusRef.current = focusCitekey;
        setPapers((prev) => (prev.some((p) => p.citekey === norm.citekey) ? prev : [norm, ...prev]));
        setSelectedKey(norm.citekey);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        appliedFocusRef.current = focusCitekey;
        const message = err instanceof Error ? err.message : "";
        if (/not found/i.test(message)) setNotice(`No paper “${focusCitekey}” in the library.`);
        else setError(message || "Could not open that library paper");
      });
    return () => {
      cancelled = true;
    };
  }, [open, focusCitekey, catalogReady, papers]);

  useEffect(() => {
    if (!selectedKey || selectedKey !== focusCitekey) return;
    const el = listRef.current?.querySelector(`[data-citekey="${CSS.escape(selectedKey)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedKey, focusCitekey, papers]);

  const selected = useMemo(
    () => papers.find((p) => p.citekey === selectedKey) ?? null,
    [papers, selectedKey],
  );

  useEffect(() => {
    if (!open) return;
    const poll = () => {
      void listLibraryAiLinks()
        .then((r) => setAiPendingCount(r.pendingCount ?? 0))
        .catch(() => undefined);
    };
    poll();
    const t = window.setInterval(poll, 5000);
    return () => window.clearInterval(t);
  }, [open]);

  // The panel stays mounted (EditorPage toggles `open`, not conditional
  // rendering), so its own sub-dialog toggles never reset on their own.
  // Without this, closing the Library from elsewhere (e.g. opening Timeline,
  // which calls closeOverlappingChrome) and reopening it could resurrect a
  // Share/AI-link/AI-review dialog the user never asked to see again.
  useEffect(() => {
    if (open) return;
    setImportOpen(false);
    setShareOpen(false);
    setAiLinkOpen(false);
    setAiReviewOpen(false);
  }, [open]);

  useEffect(() => {
    if (!selected) {
      setPdfHint(null);
      return;
    }
    let cancelled = false;
    setPdfHint(null);
    void getLibraryPdfSource(selected.citekey, { probe: !selected.attachment })
      .then((hint) => {
        if (!cancelled) setPdfHint(hint);
      })
      .catch(() => {
        if (!cancelled) setPdfHint(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.citekey, selected?.attachment]);

  const allTags = useMemo(() => {
    // Sidebar filters only show topics already used — suggestions live in the detail pane.
    const tags = new Set<string>();
    for (const p of papers) for (const t of p.tags) tags.add(t);
    return [...tags].sort();
  }, [papers]);

  const clearSmartFilters = () => {
    setCollectionFilter(null);
    setTagFilter(null);
    setStarredOnly(false);
  };

  const toggleChecked = (citekey: string) => {
    setCheckedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(citekey)) next.delete(citekey);
      else next.add(citekey);
      return next;
    });
  };

  const patchOne = async (citekey: string, body: Parameters<typeof patchLibraryPaper>[1]) => {
    const updated = await patchLibraryPaper(citekey, body);
    upsertLocal(updated);
    return updated;
  };

  const toggleStar = async (paper: PaperRecord, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      await patchOne(paper.citekey, { starred: !paper.starred });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update star");
    }
  };

  const setRating = async (paper: PaperRecord, rating: number) => {
    try {
      await patchOne(paper.citekey, { rating });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update rating");
    }
  };

  const addTag = async (paper: PaperRecord, tag: string) => {
    const t = tag.trim();
    if (!t || paper.tags.includes(t)) return;
    try {
      await patchOne(paper.citekey, { tags: [...paper.tags, t] });
      setTagDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add tag");
    }
  };

  const removeTag = async (paper: PaperRecord, tag: string) => {
    try {
      await patchOne(paper.citekey, { tags: paper.tags.filter((x) => x !== tag) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove tag");
    }
  };

  const toggleCollectionMembership = async (paper: PaperRecord, collectionId: string) => {
    const has = paper.collections.includes(collectionId);
    const collections = has
      ? paper.collections.filter((c) => c !== collectionId)
      : [...paper.collections, collectionId];
    try {
      await patchOne(paper.citekey, { collections });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update collections");
    }
  };

  const createCollection = async (opts?: { assignSelected?: boolean; assignChecked?: boolean }) => {
    const name = newCollectionName.trim();
    if (!name) return;
    const id = slugCollectionId(name);
    const assignChecked = Boolean(opts?.assignChecked && checkedKeys.size > 0);
    const assignSelected = opts?.assignSelected !== false && !assignChecked && Boolean(selected);
    try {
      const coll = await createLibraryCollection(id, name);
      setCollections(coll);
      setNewCollectionName("");
      if (assignChecked) {
        const citekeys = [...checkedKeys];
        setBusy(true);
        try {
          const { papers: updated } = await bulkPatchLibraryPapers({
            citekeys,
            collectionsAdd: [id],
          });
          const map = new Map(updated.map((p) => [p.citekey, normalizePaper(p)]));
          setPapers((prev) => prev.map((p) => map.get(p.citekey) ?? p));
          setCheckedKeys(new Set());
        } finally {
          setBusy(false);
        }
      } else if (assignSelected && selected) {
        await toggleCollectionMembership(selected, id);
      }
      setCollectionFilter(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create collection");
    }
  };

  const runBulk = async (body: Omit<Parameters<typeof bulkPatchLibraryPapers>[0], "citekeys">) => {
    const citekeys = [...checkedKeys];
    if (!citekeys.length) return;
    setBusy(true);
    try {
      const { papers: updated } = await bulkPatchLibraryPapers({ citekeys, ...body });
      const map = new Map(updated.map((p) => [p.citekey, normalizePaper(p)]));
      setPapers((prev) => prev.map((p) => map.get(p.citekey) ?? p));
      setCheckedKeys(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk update failed");
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      // A nested dialog (Share / AI link / AI review) renders on top of this
      // panel; Escape should close just that dialog, not fall through to
      // clearing the search box or closing the whole Library panel under it.
      if (shareOpen) {
        setShareOpen(false);
        e.preventDefault();
        return;
      }
      if (aiLinkOpen) {
        setAiLinkOpen(false);
        e.preventDefault();
        return;
      }
      if (aiReviewOpen) {
        setAiReviewOpen(false);
        e.preventDefault();
        return;
      }
      if (checkedKeys.size) {
        setCheckedKeys(new Set());
        e.preventDefault();
        return;
      }
      if (query) {
        setQuery("");
        e.preventDefault();
        return;
      }
      if (selectedKey) {
        setSelectedKey(null);
        e.preventDefault();
        return;
      }
      onClose();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!papers.length) return;
      const idx = papers.findIndex((p) => p.citekey === selectedKey);
      const next =
        e.key === "ArrowDown"
          ? papers[Math.min(papers.length - 1, Math.max(0, idx + 1))]
          : papers[Math.max(0, idx <= 0 ? 0 : idx - 1)];
      if (next) {
        setSelectedKey(next.citekey);
        const el = listRef.current?.querySelector(`[data-citekey="${next.citekey}"]`);
        el?.scrollIntoView({ block: "nearest" });
      }
    }
    if (e.key === "Enter" && selectedKey && onCiteIntoProject) {
      onCiteIntoProject(selectedKey);
    }
  };

  const saveNotes = async (notes: string) => {
    if (!selected) return;
    try {
      await patchOne(selected.citekey, { notes });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  };

  const runImportLink = async () => {
    if (!importLink.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await importLibraryLink({ link: importLink.trim() });
      setImportLink("");
      setImportOpen(false);
      await refresh();
      if (!result.created && result.existingCitekey) {
        setSelectedKey(result.existingCitekey);
        setNotice(
          `Already in library as ${result.existingCitekey}${result.match ? ` (matched by ${result.match})` : ""}`,
        );
      } else if (result.created) {
        setSelectedKey(result.paper.citekey);
        setNotice(`Imported ${result.paper.citekey}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const runImportBib = async () => {
    if (!importBib.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await importLibraryBibtex(importBib);
      setImportBib("");
      await refresh();
      if (result.imported.length === 0) {
        const why =
          result.errors.map((item) => item.error).filter(Boolean).join(" ") ||
          (result.skipped.length > 0
            ? `Nothing new to add. ${result.skipped.length} entr${result.skipped.length === 1 ? "y is" : "ies are"} already in the library.`
            : "No papers were imported.");
        setError(why);
        return;
      }
      setImportOpen(false);
      const skipped = result.skipped.length;
      const parts = [
        `Imported ${result.imported.length}`,
        skipped ? `skipped ${skipped} duplicate${skipped === 1 ? "" : "s"}` : null,
        result.errors.length ? `${result.errors.length} error(s)` : null,
      ].filter(Boolean);
      setNotice(parts.join(" · "));
      if (result.skipped[0]?.existingCitekey) {
        setSelectedKey(result.skipped[0].existingCitekey);
      } else if (result.imported[0]) {
        setSelectedKey(result.imported[0].citekey);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "BibTeX import failed");
    } finally {
      setBusy(false);
    }
  };

  const onDropPdf = async (file: File) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const pdfBase64 = btoa(binary);
      const result = await importLibraryPdf({ pdfBase64, filename: file.name });
      await refresh();
      setSelectedKey(result.paper.citekey);
      if (!result.created) {
        setNotice(
          `PDF attached to existing ${result.existingCitekey ?? result.paper.citekey}${
            result.match ? ` (matched by ${result.match})` : ""
          }`,
        );
      } else {
        setNotice(`Imported PDF as ${result.paper.citekey}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "PDF import failed");
    } finally {
      setBusy(false);
    }
  };

  const attachPdfToSelected = async (file: File, replace: boolean) => {
    if (!selectedKey) return;
    setBusy(true);
    setError(null);
    try {
      const result = await uploadPaperPdf(selectedKey, file, replace);
      setPdfRevision((n) => n + 1);
      upsertLocal(result.paper);
      await refresh();
      if (result.replaced) {
        setNotice(
          `PDF replaced — ${result.factsUntagged} fact${result.factsUntagged === 1 ? "" : "s"} untagged (status kept).`,
        );
      } else {
        setNotice("PDF attached.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "PDF upload failed");
    } finally {
      setBusy(false);
      setPdfReplacePrompt(null);
      setDetailPdfDrag(false);
      detailDragDepth.current = 0;
    }
  };

  const onDetailPdfFile = async (file: File | undefined | null) => {
    if (!file || !selectedKey) return;
    if (!isPdfFile(file)) {
      setError("Only PDF files can be uploaded.");
      return;
    }
    const paper = papers.find((p) => p.citekey === selectedKey);
    if (!paper?.attachment) {
      await attachPdfToSelected(file, false);
      return;
    }
    setPdfReplacePrompt(await previewPdfReplace(selectedKey, file));
  };

  const detailPdfDropHandlers = {
    onDragEnter: (ev: ReactDragEvent) => {
      if (![...ev.dataTransfer.types].includes("Files")) return;
      ev.preventDefault();
      ev.stopPropagation();
      detailDragDepth.current += 1;
      setDetailPdfDrag(true);
    },
    onDragOver: (ev: ReactDragEvent) => {
      if (![...ev.dataTransfer.types].includes("Files")) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.dataTransfer.dropEffect = "copy";
      setDetailPdfDrag(true);
    },
    onDragLeave: (ev: ReactDragEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      detailDragDepth.current = Math.max(0, detailDragDepth.current - 1);
      if (detailDragDepth.current === 0) setDetailPdfDrag(false);
    },
    onDrop: (ev: ReactDragEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      detailDragDepth.current = 0;
      setDetailPdfDrag(false);
      const file = ev.dataTransfer.files?.[0];
      void onDetailPdfFile(file);
    },
  };

  const runExport = async (
    format: "bibtex" | "ris",
    opts?: { copy?: boolean; citekeys?: string[]; collection?: string | null },
  ) => {
    const citekeys =
      opts?.citekeys ??
      (checkedKeys.size > 0 ? [...checkedKeys] : selectedKey ? [selectedKey] : undefined);
    const collection =
      opts?.collection !== undefined
        ? opts.collection
        : !citekeys?.length
          ? collectionFilter
          : undefined;
    if (!citekeys?.length && !collection) {
      setError("Select papers or a collection to export");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await exportLibraryPapers({
        citekeys,
        collection: collection ?? undefined,
        format,
      });
      if (opts?.copy) {
        const ok = await copyText(result.text);
        setNotice(ok ? `Copied ${result.count} ${format === "ris" ? "RIS" : "BibTeX"} entries` : "Clipboard blocked");
      } else {
        downloadTextFile(
          result.filename,
          result.text,
          format === "ris" ? "application/x-research-info-systems" : "application/x-bibtex",
        );
        setNotice(`Downloaded ${result.filename} (${result.count} papers)`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusy(false);
    }
  };

  const runIntegrity = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await checkLibraryPaperIntegrity(selected.citekey, { force: true });
      setPapers((prev) =>
        prev.map((p) =>
          p.citekey === result.citekey ? { ...p, integrity: result.integrity } : p,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Integrity check failed");
    } finally {
      setBusy(false);
    }
  };

  const runEnrichSelected = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await enrichLibraryPaper(selected.citekey, { force: true });
      setPapers((prev) => prev.map((p) => (p.citekey === result.paper.citekey ? result.paper : p)));
      if (!result.enriched && result.reason) {
        setError(`Lookup: ${result.reason}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Enrich failed");
    } finally {
      setBusy(false);
    }
  };

  const runCheckAll = async () => {
    setBusy(true);
    setError(null);
    try {
      const enrich = await enrichLibrary({ force: false, checkIntegrity: true });
      const unchecked = enrich.results.filter(
        (r) => r.paper.integrity.existence === "unresolved" || !r.paper.integrity.lastChecked,
      );
      if (unchecked.length) {
        await checkLibraryIntegrity({
          force: true,
          citekeys: unchecked.map((r) => r.citekey),
        });
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Library check failed");
    } finally {
      setBusy(false);
    }
  };

  const runProjectCitationCheck = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      const report = await checkProjectCitations(projectId, { force: true });
      onCitationsChanged?.(report.claims);
      const claimByKey = new Map<string, CitationInstance>();
      for (const c of report.claims) claimByKey.set(c.citekey, c);
      setLitRows(
        papers.map((p) => {
          const claim = claimByKey.get(p.citekey);
          return {
            paper: p,
            relevance: p.tags[0] ?? "—",
            claim: claim?.verdict ?? "not_checked",
            integrity: `${p.integrity.existence}/${p.integrity.retraction}`,
            importSelected: false,
          };
        }),
      );
      setViewMode("litreview");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Citation check failed");
    } finally {
      setBusy(false);
    }
  };

  const seedLitReviewFromLibrary = () => {
    setLitRows(
      papers.map((p) => ({
        paper: p,
        relevance: "library",
        claim: "not_checked",
        integrity: `${p.integrity.existence}/${p.integrity.retraction}`,
        importSelected: false,
      })),
    );
    setViewMode("litreview");
  };

  if (!open) return null;

  const isPage = variant === "page";
  const lastProject = readLastProject();

  return (
    <aside
      className={`${isPage ? "library-page" : "history-drawer library-drawer"} density-${density}${selecting ? " is-selecting" : ""}`}
      role={isPage ? "main" : "dialog"}
      aria-label="Citation library"
      onKeyDown={onKeyDown}
    >
      <div className="library-phone-bar">
        <strong>Library · {papers.length}</strong>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Search library"
          aria-pressed={phoneSearch}
          onClick={() => setPhoneSearch((v) => !v)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
        </button>
        <button type="button" className="btn btn-primary" aria-pressed={importOpen} onClick={() => setImportOpen((v) => !v)}>
          + Add
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Library menu"
          aria-expanded={phoneMenu}
          onClick={() => setPhoneMenu((v) => !v)}
        >
          ⋯
        </button>
        {phoneMenu ? (
          <div className="library-phone-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { setPhoneMenu(false); viewMode === "litreview" ? setViewMode("browse") : seedLitReviewFromLibrary(); }}>
              Lit review
            </button>
            <Link
              to={selectedKey ? `/facts?paper=${encodeURIComponent(selectedKey)}` : "/facts"}
              role="menuitem"
              onClick={() => setPhoneMenu(false)}
            >
              Facts
            </Link>
            <button type="button" role="menuitem" onClick={() => { setPhoneMenu(false); void runCheckAll(); }}>
              Check all
            </button>
            <button type="button" role="menuitem" onClick={() => { setPhoneMenu(false); setShareOpen(true); }}>
              Share
            </button>
            <button type="button" role="menuitem" onClick={() => { setPhoneMenu(false); setAiLinkOpen(true); }}>
              AI link
            </button>
            <button type="button" role="menuitem" onClick={() => { setPhoneMenu(false); setAiReviewOpen(true); }}>
              Review queue{aiPendingCount ? ` (${aiPendingCount})` : ""}
            </button>
            <button type="button" role="menuitem" onClick={() => { setPhoneMenu(false); setDensity((d) => (d === "compact" ? "comfortable" : "compact")); }}>
              Density
            </button>
            <button type="button" role="menuitem" onClick={() => { setPhoneMenu(false); setSelecting((v) => !v); }}>
              {selecting ? "Done selecting" : "Select"}
            </button>
          </div>
        ) : null}
      </div>
      {phoneSearch ? (
        <input
          className="library-search library-phone-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title, authors, topics…"
          aria-label="Filter library"
        />
      ) : null}
      <div className="history-drawer-head">
        <div>
          <strong>Library</strong>
          <div className="library-head-meta">
            {papers.length} paper{papers.length === 1 ? "" : "s"}
            {checkedKeys.size ? ` · ${checkedKeys.size} selected` : ""}
          </div>
        </div>
        <div className="history-drawer-actions">
          {isPage ? (
            <div className="library-tools">
              <button
                type="button"
                className={`btn btn-ghost${toolsOpen ? " is-active" : ""}`}
                aria-expanded={toolsOpen}
                aria-haspopup="menu"
                onClick={() => setToolsOpen((v) => !v)}
              >
                Tools
              </button>
              {toolsOpen ? (
                <div className="library-tools-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setDensity((d) => (d === "compact" ? "comfortable" : "compact"));
                    }}
                  >
                    {density === "compact" ? "Comfortable density" : "Compact density"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={viewMode === "litreview" ? "is-active" : undefined}
                    onClick={() => {
                      if (viewMode === "litreview") setViewMode("browse");
                      else seedLitReviewFromLibrary();
                      setToolsOpen(false);
                    }}
                  >
                    Lit review
                  </button>
                  <Link
                    role="menuitem"
                    to={selectedKey ? `/facts?paper=${encodeURIComponent(selectedKey)}` : "/facts"}
                    className="library-tools-link"
                    onClick={() => setToolsOpen(false)}
                  >
                    Facts
                  </Link>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    onClick={() => {
                      void runCheckAll();
                      setToolsOpen(false);
                    }}
                  >
                    {busy ? "Checking…" : "Check all"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShareOpen(true);
                      setToolsOpen(false);
                    }}
                  >
                    Share
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAiLinkOpen(true);
                      setToolsOpen(false);
                    }}
                  >
                    AI link
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={aiPendingCount ? "has-pending" : undefined}
                    onClick={() => {
                      setAiReviewOpen(true);
                      setToolsOpen(false);
                    }}
                  >
                    Review{aiPendingCount ? ` (${aiPendingCount})` : ""}
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label={density === "compact" ? "Comfortable density" : "Compact density"}
                title={density === "compact" ? "Comfortable density" : "Compact density"}
                onClick={() => setDensity((d) => (d === "compact" ? "comfortable" : "compact"))}
              >
                {density === "compact" ? "Comfortable" : "Compact"}
              </button>
              <button
                type="button"
                className={`btn btn-ghost${viewMode === "litreview" ? " is-active" : ""}`}
                title="AI literature review table"
                onClick={() => (viewMode === "litreview" ? setViewMode("browse") : seedLitReviewFromLibrary())}
              >
                Lit review
              </button>
              <Link
                to={selectedKey ? `/facts?paper=${encodeURIComponent(selectedKey)}` : "/facts"}
                className="btn btn-ghost"
                title={selectedKey ? `Review facts for ${selectedKey}` : "Review extracted facts"}
              >
                Facts
              </Link>
              {projectId ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  title="Scan & check project citations"
                  disabled={busy}
                  onClick={() => void runProjectCitationCheck()}
                >
                  Check cites
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-ghost"
                title="Enrich from Crossref/OpenAlex and verify all papers"
                disabled={busy}
                onClick={() => void runCheckAll()}
              >
                {busy ? "Checking…" : "Check all"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                title="Share papers with a private link"
                onClick={() => setShareOpen(true)}
              >
                Share
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                title="Mint an AI link for ChatGPT to verify and propose papers"
                onClick={() => setAiLinkOpen(true)}
              >
                AI link
              </button>
              <button
                type="button"
                className={`btn btn-ghost${aiPendingCount ? " has-pending" : ""}`}
                title="Review pending AI library additions"
                onClick={() => setAiReviewOpen(true)}
              >
                Review{aiPendingCount ? ` (${aiPendingCount})` : ""}
              </button>
            </>
          )}
          <button type="button" className="btn btn-primary" onClick={() => setImportOpen((v) => !v)}>
            Add paper
          </button>
          {!isPage ? (
            <button type="button" className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <ErrorBanner className="library-error" onDismiss={() => setError(null)}>
          {error}
        </ErrorBanner>
      ) : null}
      {notice ? <div className="library-notice">{notice}</div> : null}
      {pathBanner ? (
        <div className="library-notice">
          {pathBanner.ok ? "Copied" : "Select the path"}
          <code className="project-path">{pathBanner.path}</code>
        </div>
      ) : null}

      {checkedKeys.size > 0 && viewMode === "browse" ? (
        <div className="library-bulk-bar" role="toolbar" aria-label="Bulk actions">
          <span className="library-bulk-count">{checkedKeys.size} selected</span>
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void runBulk({ starred: true })}>
            Star
          </button>
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void runBulk({ starred: false })}>
            Unstar
          </button>
          <select
            className="library-inline-select"
            disabled={busy || !collections}
            defaultValue=""
            onChange={(e) => {
              const id = e.target.value;
              if (id) void runBulk({ collectionsAdd: [id] });
              e.target.value = "";
            }}
            aria-label="Add selected to collection"
          >
            <option value="">Add to collection…</option>
            {collections
              ? Object.entries(collections.collections).map(([id, c]) => (
                  <option key={id} value={id}>
                    {c.name}
                  </option>
                ))
              : null}
          </select>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={busy}
            title="Download BibTeX"
            onClick={() => void runExport("bibtex")}
          >
            BibTeX
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={busy}
            title="Copy BibTeX"
            onClick={() => void runExport("bibtex", { copy: true })}
          >
            Copy .bib
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={busy}
            title="Download RIS"
            onClick={() => void runExport("ris")}
          >
            RIS
          </button>
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setShareOpen(true)}>
            Share
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setCheckedKeys(new Set())}>
            Clear
          </button>
        </div>
      ) : null}

      {importOpen ? (
        <div className="library-import">
          <label className="library-field">
            Paste DOI / arXiv / URL
            <input
              value={importLink}
              onChange={(e) => setImportLink(e.target.value)}
              placeholder="10.1234/… or arxiv:2301.00001"
              disabled={busy}
            />
          </label>
          <div className="library-import-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void runImportLink()}>
              Import link
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              disabled={busy || !importLink.trim()}
              title="Fetch the page and save a text snapshot as a web source"
              onClick={() => {
                void (async () => {
                  if (!importLink.trim()) return;
                  setBusy(true);
                  try {
                    const result = await importLibraryWeb({ url: importLink.trim() });
                    setImportLink("");
                    setImportOpen(false);
                    await refresh();
                    setSelectedKey(result.paper.citekey);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Could not add web page");
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              Add web page
            </button>
          </div>
          <label className="library-field">
            Bulk BibTeX
            <textarea
              value={importBib}
              onChange={(e) => setImportBib(e.target.value)}
              rows={4}
              placeholder="@article{…}"
              disabled={busy}
            />
          </label>
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void runImportBib()}>
            Import BibTeX
          </button>
          <div
            className="library-drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f?.type === "application/pdf" || f?.name.endsWith(".pdf")) void onDropPdf(f);
            }}
          >
            Drop a PDF here
          </div>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() =>
              void createLibraryPaper({ title: "Untitled paper", source: "manual" }).then(() => refresh())
            }
          >
            Add blank
          </button>
        </div>
      ) : null}

      {viewMode === "litreview" ? (
        <div className="library-litreview">
          <p className="muted">
            Candidate papers — import is a deliberate checkbox action (never a silent agent write).
            Claim-support verdicts are triage signals, not certified facts.
          </p>
          <div className="library-lit-cards">
            {litRows.map((row, idx) => (
              <article key={row.paper.citekey} className="library-lit-card">
                <label className="share-check">
                  <input
                    type="checkbox"
                    checked={row.importSelected}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setLitRows((rows) => rows.map((r, i) => (i === idx ? { ...r, importSelected: checked } : r)));
                    }}
                  />
                  <span>Import</span>
                </label>
                <div className="library-item-title">{row.paper.title}</div>
                <p><span>Relevance</span> {row.relevance}</p>
                <p><span>Claim support</span> {row.claim}</p>
                <p><span>Integrity</span> {row.integrity}</p>
              </article>
            ))}
          </div>
          <table className="library-lit-table">
            <thead>
              <tr>
                <th>Import</th>
                <th>Paper</th>
                <th>Relevance</th>
                <th>Claim support</th>
                <th>Integrity</th>
              </tr>
            </thead>
            <tbody>
              {litRows.map((row, idx) => (
                <tr key={row.paper.citekey}>
                  <td>
                    <input
                      type="checkbox"
                      checked={row.importSelected}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setLitRows((rows) =>
                          rows.map((r, i) => (i === idx ? { ...r, importSelected: checked } : r)),
                        );
                      }}
                    />
                  </td>
                  <td>
                    <div className="library-item-title">{row.paper.title}</div>
                    <div className="library-item-key">{row.paper.citekey}</div>
                  </td>
                  <td>{row.relevance}</td>
                  <td>
                    <span className="lib-badge">{row.claim}</span>
                  </td>
                  <td>
                    <span className="lib-badge">{row.integrity}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !litRows.some((r) => r.importSelected)}
            onClick={() => {
              // Already in library when seeded from library; checkbox confirms deliberate keep/cite.
              const selected = litRows.filter((r) => r.importSelected);
              for (const row of selected) onCiteIntoProject?.(row.paper.citekey);
            }}
          >
            Cite selected into project
          </button>
        </div>
      ) : (
      <div className={`library-master${selectedKey ? " has-selection" : ""}`}>
        <div className="library-phone-chips" role="toolbar" aria-label="Filters">
          <button
            type="button"
            className={`library-chip${!collectionFilter && !tagFilter && !starredOnly ? " is-active" : ""}`}
            onClick={clearSmartFilters}
          >
            All
          </button>
          <button
            type="button"
            className={`library-chip${starredOnly ? " is-active" : ""}`}
            onClick={() => setStarredOnly((v) => !v)}
          >
            ★ Starred
          </button>
          <button type="button" className="library-chip" onClick={() => setPhoneSheet("collections")}>
            Collections ▾
          </button>
          <button type="button" className="library-chip" onClick={() => setPhoneSheet("topics")}>
            Topics ▾
          </button>
          <button type="button" className="library-chip" onClick={() => setPhoneSheet("sort")}>
            Sort: {SORT_OPTIONS.find((o) => o.id === sort)?.label ?? "Recent"} ▾
          </button>
        </div>
        <div className="library-master-split split-row" ref={masterSplitRef}>
        <div
          className={`pane library-sidebar-pane${sidebarCollapsed ? " is-collapsed" : ""}`}
          style={{ flex: `0 0 ${sidebarCollapsed ? 40 : sidebarWidth}px` }}
        >
          <div className="library-sidebar-pane-head">
            {!sidebarCollapsed ? <strong>Filters</strong> : null}
            <button
              type="button"
              className="btn btn-ghost btn-icon tree-collapse-btn"
              onClick={toggleSidebarCollapsed}
              title={sidebarCollapsed ? "Show filters" : "Hide filters"}
              aria-label={sidebarCollapsed ? "Show filters" : "Hide filters"}
              aria-expanded={!sidebarCollapsed}
            >
              {sidebarCollapsed ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>
          {!sidebarCollapsed ? (
        <div className="library-sidebar">
          <input
            ref={searchRef}
            className="library-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title, authors, topics…"
            aria-label="Filter library"
          />
          <label className="library-field library-sort-field">
            Sort
            <select
              className="library-inline-select"
              value={sort}
              onChange={(e) => setSort(e.target.value as LibrarySort)}
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <div className="library-filter-group">
            <div className="library-filter-heading">Smart views</div>
            <div className="library-filters" role="toolbar" aria-label="Smart views">
              <button
                type="button"
                className={`library-chip${!collectionFilter && !tagFilter && !starredOnly ? " is-active" : ""}`}
                onClick={clearSmartFilters}
              >
                All
              </button>
              <button
                type="button"
                className={`library-chip${starredOnly ? " is-active" : ""}`}
                onClick={() => setStarredOnly((v) => !v)}
              >
                ★ Starred
              </button>
            </div>
          </div>

          <div className="library-filter-group" data-section="collections">
            <div className="library-filter-heading">Collections</div>
            <div className="library-filters" role="toolbar" aria-label="Collections">
              {collections
                ? Object.entries(collections.collections).map(([id, c]) => (
                    <button
                      key={id}
                      type="button"
                      className={`library-chip${collectionFilter === id ? " is-active" : ""}`}
                      onClick={() => setCollectionFilter((cur) => (cur === id ? null : id))}
                    >
                      {c.name}
                    </button>
                  ))
                : null}
            </div>
            <div className="library-new-collection">
              <input
                value={newCollectionName}
                onChange={(e) => setNewCollectionName(e.target.value)}
                placeholder="Create collection…"
                aria-label="New collection name"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void createCollection({
                      assignSelected: false,
                      assignChecked: checkedKeys.size > 0,
                    });
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-quiet"
                disabled={!newCollectionName.trim()}
                onClick={() =>
                  void createCollection({
                    assignSelected: false,
                    assignChecked: checkedKeys.size > 0,
                  })
                }
              >
                Create
              </button>
            </div>
            {collectionFilter ? (
              <div className="library-export-row">
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={busy}
                  onClick={() => void runExport("bibtex", { collection: collectionFilter })}
                >
                  Export collection .bib
                </button>
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={busy}
                  onClick={() => void runExport("ris", { collection: collectionFilter })}
                >
                  Export .ris
                </button>
              </div>
            ) : null}
          </div>

          <details className="library-filter-group" data-section="topics">
            <summary className="library-filter-heading">Topics{tagFilter ? ` · #${tagFilter}` : ""}</summary>
            <div className="library-filters" role="toolbar" aria-label="Topics">
              {allTags.length ? (
                allTags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`library-chip${tagFilter === t ? " is-active" : ""}`}
                    onClick={() => setTagFilter((cur) => (cur === t ? null : t))}
                  >
                    #{t}
                  </button>
                ))
              ) : (
                <span className="library-hint">No topics yet — add on a paper</span>
              )}
            </div>
          </details>
        </div>
          ) : null}
        </div>
        {!sidebarCollapsed ? (
          <div
            className={`split-handle library-sidebar-handle${sidebarDragging ? " active" : ""}`}
            onPointerDown={() => setSidebarDragging(true)}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize filters"
          />
        ) : null}
        <SplitPane
          className="library-list-detail-split"
          storageKey="openleaf.library.listDetail"
          initialLeftRatio={0.42}
          minLeft={220}
          minRight={280}
          leftClassName="library-list-pane"
          rightClassName="library-detail-pane"
          left={
        <ul className="library-list" ref={listRef}>
          {papers.map((p) => {
            const badge = integrityBadge(p);
            const checked = checkedKeys.has(p.citekey);
            return (
              <li key={p.citekey}>
                <div
                  className={`library-item${selectedKey === p.citekey ? " is-selected" : ""}${checked ? " is-checked" : ""}`}
                  data-citekey={p.citekey}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setPathBanner(null);
                    setPathMenu({ x: e.clientX, y: e.clientY, citekey: p.citekey, hasPdf: Boolean(p.attachment) });
                  }}
                >
                  <div className="library-item-rail">
                    <input
                      type="checkbox"
                      checked={checked}
                      aria-label={`Select ${p.citekey}`}
                      onChange={() => toggleChecked(p.citekey)}
                    />
                    <button
                      type="button"
                      className={`library-star${p.starred ? " is-on" : ""}`}
                      title={p.starred ? "Unstar" : "Star"}
                      aria-label={p.starred ? "Unstar" : "Star"}
                      aria-pressed={p.starred}
                      onClick={(e) => void toggleStar(p, e)}
                    >
                      {p.starred ? "★" : "☆"}
                    </button>
                  </div>
                  <button
                    type="button"
                    className="library-item-body"
                    onClick={() => {
                      if (selecting) toggleChecked(p.citekey);
                      else {
                        setFocusFactId(null);
                        setSelectedKey(p.citekey);
                      }
                    }}
                    onPointerDown={() => {
                      if (pressTimer.current) window.clearTimeout(pressTimer.current);
                      pressTimer.current = window.setTimeout(() => {
                        setSelecting(true);
                        setCheckedKeys((prev) => new Set(prev).add(p.citekey));
                      }, 450);
                    }}
                    onPointerUp={() => {
                      if (pressTimer.current) window.clearTimeout(pressTimer.current);
                    }}
                    onPointerLeave={() => {
                      if (pressTimer.current) window.clearTimeout(pressTimer.current);
                    }}
                  >
                    <div className="library-item-title">{p.title}</div>
                    <div className="library-phone-meta">
                      <span>{phoneMeta(p)}</span>
                      <span className={badge.className}>{badge.label}</span>
                    </div>
                    <div className="library-item-meta">
                      <span className="library-authors">{authorsLabel(p, { compact: true })}</span>
                      {p.year != null ? <span>· {p.year}</span> : null}
                      {p.rating > 0 ? <span className="library-rating-mini">{ratingStars(p.rating)}</span> : null}
                      {(() => {
                        const pdf = pdfListHint(p);
                        if (pdf === "local") {
                          return (
                            <span className="lib-pdf-badge is-local" title="PDF attached">
                              PDF
                            </span>
                          );
                        }
                        if (pdf === "arxiv") {
                          return (
                            <span className="lib-pdf-badge is-available" title="arXiv PDF available to download">
                              PDF↓
                            </span>
                          );
                        }
                        return null;
                      })()}
                      <span className={badge.className}>{badge.label}</span>
                    </div>
                    {p.tags.length ? (
                      <div className="library-item-collections">
                        {p.tags.slice(0, 4).map((t) => (
                          <span key={t} className="lib-badge">
                            #{t}
                          </span>
                        ))}
                        {p.tags.length > 4 ? <span className="muted">+{p.tags.length - 4}</span> : null}
                      </div>
                    ) : null}
                    {p.collections.length ? (
                      <div className="library-item-collections">
                        {collectionNames(p, collections).map((name) => (
                          <span key={name} className="lib-badge lib-badge-collection">
                            {name}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <div className="library-item-key">{p.citekey}</div>
                  </button>
                </div>
              </li>
            );
          })}
          {!papers.length ? (
            <li className="library-empty">
              No papers yet.
              <button type="button" className="btn btn-primary" onClick={() => setImportOpen(true)}>
                Add paper
              </button>
            </li>
          ) : null}
        </ul>
          }
          right={
        <div
          className={`library-detail${detailPdfDrag && selected ? " is-pdf-drag" : ""}`}
          {...(selected ? detailPdfDropHandlers : {})}
        >
          {selected && detailPdfDrag ? (
            <div className="library-detail-pdf-drop-overlay" aria-hidden>
              <div className="library-detail-pdf-drop-card">
                Drop PDF to {selected.attachment ? "replace" : "attach"}
                <span className="muted">{selected.citekey}</span>
              </div>
            </div>
          ) : null}
          {pdfReplacePrompt ? (
            <div className="library-pdf-replace-dialog" role="alertdialog" aria-modal="true">
              <div className="library-pdf-replace-card">
                <h3>Replace PDF?</h3>
                <p>
                  This paper already has a PDF. Replacing it will <strong>untag</strong>{" "}
                  {pdfReplacePrompt.taggedFactCount} fact
                  {pdfReplacePrompt.taggedFactCount === 1 ? "" : "s"} that currently point into the
                  PDF
                  {pdfReplacePrompt.totalFacts ? ` (${pdfReplacePrompt.totalFacts} total)` : ""}.
                </p>
                <p className="muted">
                  Untagged facts keep their answers and approval status. Only the PDF anchors are
                  cleared — you can retag them afterward.
                </p>
                <div className="library-pdf-pin-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => void attachPdfToSelected(pdfReplacePrompt.file, true)}
                  >
                    {busy ? "Replacing…" : "Replace PDF"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => setPdfReplacePrompt(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {selected ? (
            <>
              <div className="library-phone-detailbar">
                <button type="button" className="btn btn-ghost" onClick={() => setSelectedKey(null)} aria-label="Back">
                  ←
                </button>
                <Link to="/" className="btn btn-ghost library-phone-projects">
                  Projects
                </Link>
                {lastProject ? (
                  <Link
                    to={`/p/${encodeURIComponent(lastProject.id)}`}
                    className="btn btn-ghost library-phone-return"
                  >
                    {lastProject.name}
                  </Link>
                ) : null}
                <button
                  type="button"
                  className={`library-star${selected.starred ? " is-on" : ""}`}
                  aria-label={selected.starred ? "Unstar" : "Star"}
                  aria-pressed={selected.starred}
                  onClick={() => void toggleStar(selected)}
                >
                  {selected.starred ? "★" : "☆"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label="Paper menu"
                  aria-expanded={detailMenu}
                  onClick={() => setDetailMenu((v) => !v)}
                >
                  ⋯
                </button>
                {detailMenu ? (
                  <div className="library-phone-menu" role="menu">
                    {onCiteIntoProject ? (
                      <button type="button" role="menuitem" onClick={() => { setDetailMenu(false); onCiteIntoProject(selected.citekey); }}>
                        Cite
                      </button>
                    ) : null}
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setDetailMenu(false);
                        document.querySelector('.library-section[data-section="pdf"]')?.scrollIntoView({ block: "start" });
                      }}
                    >
                      Open PDF
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setDetailMenu(false);
                        void copyLibraryPath(selected.citekey, "folder");
                      }}
                    >
                      Copy folder path
                    </button>
                    {selected.attachment ? (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setDetailMenu(false);
                          void copyLibraryPath(selected.citekey, "pdf");
                        }}
                      >
                        Copy PDF path
                      </button>
                    ) : null}
                    <button type="button" role="menuitem" onClick={() => { setDetailMenu(false); setShareOpen(true); }}>
                      Share
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setDetailMenu(false);
                        if (!confirm(`Delete ${selected.citekey}?`)) return;
                        void deleteLibraryPaper(selected.citekey).then(() => {
                          setSelectedKey(null);
                          void refresh();
                        });
                      }}
                    >
                      Delete
                    </button>
                  </div>
                ) : null}
              </div>
              <h2 className="library-phone-title">{selected.title}</h2>
              <button
                type="button"
                className="btn btn-ghost library-back"
                onClick={() => setSelectedKey(null)}
              >
                ← Back to list
              </button>
              <div className="library-detail-head">
                <div className="library-detail-title-row">
                  <button
                    type="button"
                    className={`library-star library-star-lg${selected.starred ? " is-on" : ""}`}
                    title={selected.starred ? "Unstar" : "Star"}
                    aria-label={selected.starred ? "Unstar" : "Star"}
                    aria-pressed={selected.starred}
                    onClick={() => void toggleStar(selected)}
                  >
                    {selected.starred ? "★" : "☆"}
                  </button>
                  <h3>{selected.title}</h3>
                </div>
                <code>{selected.citekey}</code>
              </div>
              <Collapsible
                title="Organize"
                section="organize"
                open={sectionOpen.organize}
                onToggle={() => setSectionOpen((s) => ({ ...s, organize: !s.organize }))}
              >
                <div className="library-rating" role="group" aria-label="Rating">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`library-star${selected.rating >= n ? " is-on" : ""}`}
                      onClick={() => void setRating(selected, selected.rating === n ? 0 : n)}
                      title={`${n} star${n === 1 ? "" : "s"}`}
                    >
                      {selected.rating >= n ? "★" : "☆"}
                    </button>
                  ))}
                </div>
                <div className="library-field">
                  <span>Collections</span>
                  <div className="library-tags">
                    {collections
                      ? Object.entries(collections.collections).map(([id, c]) => {
                          const on = selected.collections.includes(id);
                          return (
                            <button
                              key={id}
                              type="button"
                              className={`lib-badge lib-badge-collection${on ? " is-on" : ""}`}
                              onClick={() => void toggleCollectionMembership(selected, id)}
                            >
                              {on ? "✓ " : ""}
                              {c.name}
                            </button>
                          );
                        })
                      : null}
                  </div>
                  <div className="library-new-collection" style={{ marginTop: "0.45rem" }}>
                    <input
                      value={newCollectionName}
                      onChange={(e) => setNewCollectionName(e.target.value)}
                      placeholder="New collection name…"
                      aria-label="Create collection and add this paper"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void createCollection({ assignSelected: true });
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-quiet"
                      disabled={!newCollectionName.trim()}
                      onClick={() => void createCollection({ assignSelected: true })}
                    >
                      Create & add
                    </button>
                  </div>
                </div>
              </Collapsible>
              <Collapsible
                title="Info"
                section="info"
                open={sectionOpen.info}
                onToggle={() => setSectionOpen((s) => ({ ...s, info: !s.info }))}
              >
                <p className="library-authors-full">{authorsLabel(selected)}</p>
                <p>
                  {selected.venue || "—"}
                  {selected.year != null ? ` · ${selected.year}` : ""}
                </p>
                {selected.url ? (
                  <p>
                    <a href={selected.url} target="_blank" rel="noreferrer">
                      {/scholar\.google\./i.test(selected.url) ? "Search on Google Scholar" : selected.url}
                    </a>
                  </p>
                ) : null}
                {selected.doi ? <p>DOI: {selected.doi}</p> : null}
                {selected.arxivId ? <p>arXiv: {selected.arxivId}</p> : null}
                {selected.abstract ? <p className="library-abstract">{selected.abstract}</p> : null}
              </Collapsible>
              <Collapsible
                title="Notes"
                section="notes"
                open={sectionOpen.notes}
                onToggle={() => setSectionOpen((s) => ({ ...s, notes: !s.notes }))}
              >
                <textarea
                  className="library-notes"
                  defaultValue={selected.notes}
                  key={selected.citekey}
                  rows={4}
                  onBlur={(e) => void saveNotes(e.target.value)}
                />
              </Collapsible>
              <Collapsible
                title={selected.attachment ? "PDF & highlights" : "PDF & highlights"}
                section="pdf"
                open={sectionOpen.pdf}
                onToggle={() => setSectionOpen((s) => ({ ...s, pdf: !s.pdf }))}
              >
                {!selected.attachment && pdfHint?.canFetch ? (
                  <div className="library-pdf-fetch">
                    <p className="muted library-hint">
                      {pdfHint.source === "arxiv"
                        ? "arXiv PDF is available for direct download."
                        : "An open-access PDF may be available."}
                    </p>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => {
                        setBusy(true);
                        setError(null);
                        void fetchLibraryPdf(selected.citekey)
                          .then((result) => {
                            upsertLocal(result.paper);
                            setPdfHint({
                              citekey: result.paper.citekey,
                              hasLocal: true,
                              directUrl: null,
                              source: "local",
                              canFetch: false,
                            });
                            setNotice(
                              `Saved PDF (${Math.round(result.bytes / 1024)} KB via ${result.source})`,
                            );
                          })
                          .catch((err) =>
                            setError(err instanceof Error ? err.message : "PDF download failed"),
                          )
                          .finally(() => setBusy(false));
                      }}
                    >
                      Download PDF
                    </button>
                  </div>
                ) : null}
                <LibraryPdfNotes
                  paper={selected}
                  pdfRevision={pdfRevision}
                  onError={(msg) => {
                    if (!isTransientPdfErrorMessage(msg)) setError(msg);
                  }}
                  onNotice={(msg) => setNotice(msg)}
                  onPaperChange={(paper) => {
                    upsertLocal(paper);
                    setSelectedKey(paper.citekey);
                    setPdfRevision((n) => n + 1);
                    void refresh();
                  }}
                  focusFactId={focusFactId}
                  initialPane={focusFactId ? "facts" : undefined}
                />
              </Collapsible>
              <Collapsible
                title="Topics"
                section="topics"
                open={sectionOpen.tags}
                onToggle={() => setSectionOpen((s) => ({ ...s, tags: !s.tags }))}
              >
                <p className="library-hint muted">Subject-matter labels (e.g. calibration, hematology).</p>
                <div className="library-tags">
                  {selected.tags.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="lib-badge is-on"
                      title="Remove topic"
                      aria-label={`Remove topic ${t}`}
                      onClick={() => void removeTag(selected, t)}
                    >
                      #{t} ×
                    </button>
                  ))}
                  {!selected.tags.length ? <span className="muted">No topics yet</span> : null}
                </div>
                <div className="library-tag-add">
                  <input
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    placeholder="Add topic…"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const t = tagDraft;
                        void addTag(selected, t).then(() => setTagDraft(""));
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => {
                      const t = tagDraft;
                      void addTag(selected, t).then(() => setTagDraft(""));
                    }}
                  >
                    Add
                  </button>
                </div>
                <div className="library-tags library-quick-tags">
                  {TOPIC_SUGGESTIONS.filter((t) => !selected.tags.includes(t)).map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="lib-badge"
                      onClick={() => void addTag(selected, t)}
                    >
                      + {t}
                    </button>
                  ))}
                </div>
              </Collapsible>
              <Collapsible
                title="Integrity"
                section="integrity"
                open={sectionOpen.integrity}
                onToggle={() => setSectionOpen((s) => ({ ...s, integrity: !s.integrity }))}
              >
                <p>
                  Existence: <strong>{selected.integrity.existence}</strong>
                </p>
                <p>
                  Retraction: <strong>{selected.integrity.retraction}</strong>
                </p>
                <p className="muted">
                  Last checked: {selected.integrity.lastChecked ?? "never"}
                </p>
                {selected.integrity.existence !== "verified" && selected.integrity.reason ? (
                  <p className="library-integrity-reason">
                    Why unchecked: <strong>{selected.integrity.reason}</strong>
                  </p>
                ) : null}
                {selected.integrity.existence !== "verified" && !selected.integrity.reason ? (
                  <p className="library-integrity-reason library-integrity-reason-warn">
                    Missing a public link — add a URL (DOI, arXiv, publisher, or source page).
                  </p>
                ) : null}
                {selected.integrity.existence === "verified" && selected.url ? (
                  <p className="muted">
                    Verified via link:{" "}
                    <a href={selected.url} target="_blank" rel="noreferrer">
                      {/scholar\.google\./i.test(selected.url) ? "Search on Google Scholar" : selected.url}
                    </a>
                  </p>
                ) : null}
                <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void runEnrichSelected()}>
                  Enrich from Crossref / OpenAlex
                </button>{" "}
                <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void runIntegrity()}>
                  Re-check now
                </button>
              </Collapsible>
              <div className="library-detail-actions">
                {projectId && onCiteIntoProject ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => onCiteIntoProject(selected.citekey)}
                  >
                    Cite into project
                  </button>
                ) : null}
                <Link
                  className="btn btn-quiet"
                  to={`/facts?paper=${encodeURIComponent(selected.citekey)}`}
                  title="Review extracted facts for this paper"
                >
                  Review facts
                </Link>
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => void copyLibraryPath(selected.citekey, "folder")}
                >
                  Copy folder path
                </button>
                {selected.attachment ? (
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => void copyLibraryPath(selected.citekey, "pdf")}
                  >
                    Copy PDF path
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={busy}
                  onClick={() => void runExport("bibtex", { citekeys: [selected.citekey] })}
                >
                  BibTeX
                </button>
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={busy}
                  onClick={() => void runExport("bibtex", { citekeys: [selected.citekey], copy: true })}
                >
                  Copy .bib
                </button>
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={busy}
                  onClick={() => void runExport("ris", { citekeys: [selected.citekey] })}
                >
                  RIS
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    if (!confirm(`Delete ${selected.citekey}?`)) return;
                    void deleteLibraryPaper(selected.citekey).then(() => {
                      setSelectedKey(null);
                      void refresh();
                    });
                  }}
                >
                  Delete
                </button>
              </div>
            </>
          ) : (
            <div className="library-empty library-empty-detail">
              <p>Select a paper</p>
              <span className="muted">Search or pick from the list</span>
            </div>
          )}
        </div>
          }
        />
        </div>
      </div>
      )}

      <LibrarySharePanel
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        citekeys={
          checkedKeys.size > 0
            ? [...checkedKeys]
            : selectedKey
              ? [selectedKey]
              : []
        }
        collectionId={collectionFilter}
        collectionName={
          collectionFilter && collections?.collections[collectionFilter]
            ? collections.collections[collectionFilter]!.name
            : null
        }
      />
      <LibraryAiLinkPanel open={aiLinkOpen} onClose={() => setAiLinkOpen(false)} />
      <LibraryAiReviewPanel
        open={aiReviewOpen}
        onClose={() => setAiReviewOpen(false)}
        onAccepted={() => void refresh()}
        onCountChange={setAiPendingCount}
      />
      {phoneSheet ? (
        <div className="library-phone-sheet" role="dialog" aria-label={phoneSheet}>
          <div className="library-phone-sheet-head">
            <strong>{phoneSheet === "sort" ? "Sort" : phoneSheet === "topics" ? "Topics" : "Collections"}</strong>
            <button type="button" className="btn btn-ghost" onClick={() => setPhoneSheet(null)}>
              Done
            </button>
          </div>
          {phoneSheet === "sort"
            ? SORT_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={`library-chip${sort === o.id ? " is-active" : ""}`}
                  onClick={() => {
                    setSort(o.id);
                    setPhoneSheet(null);
                  }}
                >
                  {o.label}
                </button>
              ))
            : null}
          {phoneSheet === "collections"
            ? Object.entries(collections?.collections ?? {}).map(([id, c]) => (
                <button
                  key={id}
                  type="button"
                  className={`library-chip${collectionFilter === id ? " is-active" : ""}`}
                  onClick={() => {
                    setCollectionFilter((cur) => (cur === id ? null : id));
                    setPhoneSheet(null);
                  }}
                >
                  {c.name}
                </button>
              ))
            : null}
          {phoneSheet === "topics"
            ? allTags.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`library-chip${tagFilter === t ? " is-active" : ""}`}
                  onClick={() => {
                    setTagFilter((cur) => (cur === t ? null : t));
                    setPhoneSheet(null);
                  }}
                >
                  #{t}
                </button>
              ))
            : null}
        </div>
      ) : null}
      {pathMenu ? (
        <div
          className="context-menu"
          style={{ left: pathMenu.x, top: pathMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button type="button" onClick={() => void copyLibraryPath(pathMenu.citekey, "folder")}>
            Copy folder path
          </button>
          {pathMenu.hasPdf ? (
            <button type="button" onClick={() => void copyLibraryPath(pathMenu.citekey, "pdf")}>
              Copy PDF path
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function Collapsible({
  title,
  open,
  onToggle,
  children,
  section,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  section?: string;
}) {
  return (
    <section className="library-section" data-section={section}>
      <button type="button" className="library-section-head" onClick={onToggle} aria-expanded={open}>
        <span>{open ? "▾" : "▸"}</span> {title}
      </button>
      {open ? <div className="library-section-body">{children}</div> : null}
    </section>
  );
}
