import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  getLibraryCollections,
  importLibraryBibtex,
  importLibraryLink,
  importLibraryPdf,
  listLibraryPapers,
  patchLibraryPaper,
  type CitationInstance,
} from "../api/client";
import type { LibraryCollections, LibrarySort, PaperRecord, ReadingStatus } from "../api/types";
import {
  TOPIC_SUGGESTIONS,
  READING_STATUSES,
  SORT_OPTIONS,
  STATUS_LABEL,
  normalizePaper,
  ratingStars,
  slugCollectionId,
  statusClass,
} from "./LibraryOrganize";
import { LibrarySharePanel } from "./LibrarySharePanel";

type Props = {
  open: boolean;
  onClose: () => void;
  /** drawer = editor overlay; page = full-screen route (no project required). */
  variant?: "drawer" | "page";
  projectId?: string;
  onCiteIntoProject?: (citekey: string) => void;
  onCitationsChanged?: (instances: CitationInstance[]) => void;
};

type Density = "compact" | "comfortable";

function authorsLabel(paper: PaperRecord, opts?: { compact?: boolean }): string {
  if (!paper.authors.length) return "Unknown authors";
  const names = paper.authors.map((a) =>
    a.given ? `${a.family}, ${a.given}` : a.family,
  );
  if (opts?.compact && names.length > 6) {
    return `${names.slice(0, 6).join("; ")}; … (+${names.length - 6})`;
  }
  return names.join("; ");
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
  onCiteIntoProject,
  onCitationsChanged,
}: Props) {
  const [papers, setPapers] = useState<PaperRecord[]>([]);
  const [collections, setCollections] = useState<LibraryCollections | null>(null);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [collectionFilter, setCollectionFilter] = useState<string | null>(null);
  const [starredOnly, setStarredOnly] = useState(false);
  const [statusFilter, setStatusFilter] = useState<ReadingStatus | null>(null);
  const [sort, setSort] = useState<LibrarySort>("added");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set());
  const [density, setDensity] = useState<Density>("comfortable");
  const [importOpen, setImportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"browse" | "litreview">("browse");
  const [litRows, setLitRows] = useState<
    Array<{ paper: PaperRecord; relevance: string; claim: string; integrity: string; importSelected: boolean }>
  >([]);
  const [importLink, setImportLink] = useState("");
  const [importBib, setImportBib] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [newCollectionName, setNewCollectionName] = useState("");
  const [sectionOpen, setSectionOpen] = useState({
    info: true,
    organize: true,
    notes: true,
    tags: true,
    integrity: true,
  });
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

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
          status: statusFilter ?? undefined,
          sort,
          limit: 2000,
        }),
        getLibraryCollections(),
      ]);
      setPapers(list.map(normalizePaper));
      setCollections(coll);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load library");
    }
  }, [query, tagFilter, collectionFilter, starredOnly, statusFilter, sort]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const t = window.setTimeout(() => searchRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open, refresh]);

  const selected = useMemo(
    () => papers.find((p) => p.citekey === selectedKey) ?? null,
    [papers, selectedKey],
  );

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
    setStatusFilter(null);
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

  const setStatus = async (paper: PaperRecord, status: ReadingStatus) => {
    try {
      await patchOne(paper.citekey, { status });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update status");
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
    try {
      await importLibraryLink({ link: importLink.trim() });
      setImportLink("");
      setImportOpen(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const runImportBib = async () => {
    if (!importBib.trim()) return;
    setBusy(true);
    try {
      await importLibraryBibtex(importBib);
      setImportBib("");
      setImportOpen(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "BibTeX import failed");
    } finally {
      setBusy(false);
    }
  };

  const onDropPdf = async (file: File) => {
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
      const pdfBase64 = btoa(binary);
      await importLibraryPdf({ pdfBase64, filename: file.name });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "PDF import failed");
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

  return (
    <aside
      className={`${isPage ? "library-page" : "history-drawer library-drawer"} density-${density}`}
      role={isPage ? "main" : "dialog"}
      aria-label="Citation library"
      onKeyDown={onKeyDown}
    >
      <div className="history-drawer-head">
        <div>
          <strong>{isPage ? "Citation library" : "Library"}</strong>
          <div className="library-head-meta">
            {papers.length} paper{papers.length === 1 ? "" : "s"}
            {checkedKeys.size ? ` · ${checkedKeys.size} selected` : ""}
          </div>
        </div>
        <div className="history-drawer-actions">
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            title={density === "compact" ? "Comfortable density" : "Compact density"}
            onClick={() => setDensity((d) => (d === "compact" ? "comfortable" : "compact"))}
          >
            {density === "compact" ? "▦" : "▤"}
          </button>
          <button
            type="button"
            className={`btn btn-ghost${viewMode === "litreview" ? " is-active" : ""}`}
            title="AI literature review table"
            onClick={() => (viewMode === "litreview" ? setViewMode("browse") : seedLitReviewFromLibrary())}
          >
            Review
          </button>
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
          <button type="button" className="btn btn-ghost btn-icon" title="Import" onClick={() => setImportOpen((v) => !v)}>
            +
          </button>
          {!isPage ? (
            <button type="button" className="btn btn-ghost btn-icon" title="Close" onClick={onClose}>
              ✕
            </button>
          ) : null}
        </div>
      </div>

      {error ? <div className="library-error">{error}</div> : null}

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
            disabled={busy}
            defaultValue=""
            onChange={(e) => {
              const v = e.target.value as ReadingStatus | "";
              if (v) void runBulk({ status: v });
              e.target.value = "";
            }}
            aria-label="Set status for selected"
          >
            <option value="">Status…</option>
            {READING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
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
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void runImportLink()}>
            Import link
          </button>
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
                className={`library-chip${!collectionFilter && !tagFilter && !starredOnly && !statusFilter ? " is-active" : ""}`}
                onClick={clearSmartFilters}
              >
                All
              </button>
              <button
                type="button"
                className={`library-chip${starredOnly ? " is-active" : ""}`}
                onClick={() => {
                  setStarredOnly((v) => !v);
                  setStatusFilter(null);
                }}
              >
                ★ Starred
              </button>
              {READING_STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`library-chip${statusFilter === s ? " is-active" : ""}`}
                  onClick={() => {
                    setStatusFilter((cur) => (cur === s ? null : s));
                    setStarredOnly(false);
                  }}
                >
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          </div>

          <div className="library-filter-group">
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
            <p className="library-hint">
              Folders for projects or reading lists. Creating while papers are selected adds them.
            </p>
          </div>

          <div className="library-filter-group">
            <div className="library-filter-heading">Topics</div>
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
          </div>
        </div>

        <ul className="library-list" ref={listRef}>
          {papers.map((p) => {
            const badge = integrityBadge(p);
            const checked = checkedKeys.has(p.citekey);
            return (
              <li key={p.citekey}>
                <div
                  className={`library-item${selectedKey === p.citekey ? " is-selected" : ""}${checked ? " is-checked" : ""}`}
                  data-citekey={p.citekey}
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
                      aria-pressed={p.starred}
                      onClick={(e) => void toggleStar(p, e)}
                    >
                      {p.starred ? "★" : "☆"}
                    </button>
                  </div>
                  <button
                    type="button"
                    className="library-item-body"
                    onClick={() => setSelectedKey(p.citekey)}
                  >
                    <div className="library-item-title">{p.title}</div>
                    <div className="library-item-meta">
                      <span className="library-authors">{authorsLabel(p, { compact: true })}</span>
                      {p.year != null ? <span>· {p.year}</span> : null}
                      <span className={statusClass(p.status)}>{STATUS_LABEL[p.status]}</span>
                      {p.rating > 0 ? <span className="library-rating-mini">{ratingStars(p.rating)}</span> : null}
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
          {!papers.length ? <li className="library-empty">No papers yet — import a link or BibTeX.</li> : null}
        </ul>

        <div className="library-detail">
          {selected ? (
            <>
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
                open={sectionOpen.organize}
                onToggle={() => setSectionOpen((s) => ({ ...s, organize: !s.organize }))}
              >
                <label className="library-field">
                  Reading status
                  <select
                    className="library-inline-select"
                    value={selected.status}
                    onChange={(e) => void setStatus(selected, e.target.value as ReadingStatus)}
                  >
                    {READING_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </label>
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
                      {selected.url}
                    </a>
                  </p>
                ) : null}
                {selected.doi ? <p>DOI: {selected.doi}</p> : null}
                {selected.arxivId ? <p>arXiv: {selected.arxivId}</p> : null}
                {selected.abstract ? <p className="library-abstract">{selected.abstract}</p> : null}
              </Collapsible>
              <Collapsible
                title="Notes"
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
                title="Topics"
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
                      {selected.url}
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
            <div className="library-empty">Select a paper</div>
          )}
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
    </aside>
  );
}

function Collapsible({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="library-section">
      <button type="button" className="library-section-head" onClick={onToggle} aria-expanded={open}>
        <span>{open ? "▾" : "▸"}</span> {title}
      </button>
      {open ? <div className="library-section-body">{children}</div> : null}
    </section>
  );
}
