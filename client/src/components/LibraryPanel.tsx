import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  checkLibraryIntegrity,
  checkLibraryPaperIntegrity,
  checkProjectCitations,
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
import type { LibraryCollections, PaperRecord } from "../api/types";

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
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [density, setDensity] = useState<Density>("comfortable");
  const [importOpen, setImportOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"browse" | "litreview">("browse");
  const [litRows, setLitRows] = useState<
    Array<{ paper: PaperRecord; relevance: string; claim: string; integrity: string; importSelected: boolean }>
  >([]);
  const [importLink, setImportLink] = useState("");
  const [importBib, setImportBib] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sectionOpen, setSectionOpen] = useState({
    info: true,
    notes: true,
    tags: true,
    integrity: true,
  });
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [{ papers: list }, coll] = await Promise.all([
        listLibraryPapers({
          q: query || undefined,
          tag: tagFilter ?? undefined,
          collection: collectionFilter ?? undefined,
          limit: 2000,
        }),
        getLibraryCollections(),
      ]);
      setPapers(list);
      setCollections(coll);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load library");
    }
  }, [query, tagFilter, collectionFilter]);

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
    const tags = new Set<string>();
    for (const p of papers) for (const t of p.tags) tags.add(t);
    return [...tags].sort();
  }, [papers]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
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
      const updated = await patchLibraryPaper(selected.citekey, { notes });
      setPapers((prev) => prev.map((p) => (p.citekey === updated.citekey ? updated : p)));
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
        <strong>{isPage ? "Citation library" : "Library"}</strong>
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
            placeholder="Filter… (Esc clears)"
            aria-label="Filter library"
          />
          <div className="library-filters" role="toolbar" aria-label="Collections and tags">
            <button
              type="button"
              className={`btn btn-ghost${!collectionFilter && !tagFilter ? " is-active" : ""}`}
              onClick={() => {
                setCollectionFilter(null);
                setTagFilter(null);
              }}
            >
              All
            </button>
            {collections
              ? Object.entries(collections.collections).map(([id, c]) => (
                  <button
                    key={id}
                    type="button"
                    className={`btn btn-ghost${collectionFilter === id ? " is-active" : ""}`}
                    onClick={() => setCollectionFilter(id)}
                  >
                    {c.name}
                  </button>
                ))
              : null}
            {allTags.map((t) => (
              <button
                key={t}
                type="button"
                className={`btn btn-ghost${tagFilter === t ? " is-active" : ""}`}
                onClick={() => setTagFilter(t)}
              >
                #{t}
              </button>
            ))}
          </div>
        </div>

        <ul className="library-list" ref={listRef}>
          {papers.map((p) => {
            const badge = integrityBadge(p);
            return (
              <li key={p.citekey}>
                <button
                  type="button"
                  data-citekey={p.citekey}
                  className={`library-item${selectedKey === p.citekey ? " is-selected" : ""}`}
                  onClick={() => setSelectedKey(p.citekey)}
                >
                  <div className="library-item-title">{p.title}</div>
                  <div className="library-item-meta">
                    <span className="library-authors">{authorsLabel(p, { compact: true })}</span>
                    {p.year != null ? <span>· {p.year}</span> : null}
                    <span className={badge.className}>{badge.label}</span>
                  </div>
                  {p.url ? (
                    <div className="library-item-url">
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {p.url.replace(/^https?:\/\//i, "").slice(0, 72)}
                        {p.url.replace(/^https?:\/\//i, "").length > 72 ? "…" : ""}
                      </a>
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
                <h3>{selected.title}</h3>
                <code>{selected.citekey}</code>
              </div>
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
                {selected.collections.length ? (
                  <p className="library-detail-collections">
                    Projects:{" "}
                    {collectionNames(selected, collections).join(" · ") || selected.collections.join(" · ")}
                  </p>
                ) : null}
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
                title="Tags"
                open={sectionOpen.tags}
                onToggle={() => setSectionOpen((s) => ({ ...s, tags: !s.tags }))}
              >
                <div className="library-tags">
                  {selected.tags.map((t) => (
                    <span key={t} className="lib-badge">
                      {t}
                    </span>
                  ))}
                  {!selected.tags.length ? <span className="muted">No tags</span> : null}
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
