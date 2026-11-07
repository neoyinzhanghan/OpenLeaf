import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  getLibrarySnapshotMeta,
  getLibrarySnapshotText,
  libraryPdfUrl,
  listAllLibraryFacts,
  listLibraryFacts,
  patchLibraryFact,
} from "../api/client";
import type {
  FactDisplayRect,
  FactStatus,
  FactType,
  LibraryFact,
  PaperFact,
  PaperRecord,
} from "../api/types";
import { libraryPaperUrl } from "../latex/libraryLink";
import { KnowledgeImpactPanel } from "./KnowledgeImpactPanel";
import { PdfViewer, type PdfAnnotationMark, type PdfHighlight } from "./PdfViewer";
import { SplitPane } from "./SplitPane";

type Props = {
  papers: PaperRecord[];
  /** Optional — Facts page uses topbar Library link instead. */
  onBack?: () => void;
  onError?: (message: string) => void;
};

const TYPES: Array<FactType | ""> = ["", "statement", "value", "question", "tag"];
const STATUSES: Array<FactStatus | ""> = [
  "unreviewed",
  "",
  "confirmed",
  "rejected",
  "not_found",
];

const STATUS_LABEL: Record<FactStatus, string> = {
  unreviewed: "Unreviewed",
  confirmed: "Confirmed",
  rejected: "Rejected",
  not_found: "Not found",
};

type SortKey = "updated" | "paper" | "answer" | "subject" | "page" | "status";
const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "paper", label: "Paper" },
  { value: "answer", label: "Answer" },
  { value: "subject", label: "Subject" },
  { value: "page", label: "Page" },
  { value: "status", label: "Status" },
  { value: "updated", label: "Updated" },
];

const STATUS_RANK: Record<FactStatus, number> = {
  unreviewed: 0,
  not_found: 1,
  confirmed: 2,
  rejected: 3,
};

function factKey(f: Pick<LibraryFact, "citekey" | "id">) {
  return `${f.citekey}:${f.id}`;
}

/** Short English label from the authoring sentence (never the machine key). */
function factSubject(fact: LibraryFact): string {
  const input = (fact.input || "").trim();
  const m = input.match(/^(?:AUROC|AUC|C-index|accuracy|F1) of (.+?) on (.+)$/i);
  if (m) {
    const model = m[1]!.trim();
    const dataset = m[2]!.trim().replace(/\s*\([^)]*\)\s*$/, "").trim();
    const label = dataset ? `${model} on ${dataset}` : model;
    return label.length <= 64 ? label : `${label.slice(0, 63)}…`;
  }
  const m2 = input.match(/^(?:AUROC|AUC|C-index|accuracy|F1) of (.+)$/i);
  if (m2?.[1]) {
    const model = m2[1].trim();
    return model.length <= 64 ? model : `${model.slice(0, 63)}…`;
  }
  if (input.length <= 72) return input || fact.key || "Fact";
  return `${input.slice(0, 70)}…`;
}

function factMetric(fact: LibraryFact): string | null {
  const m = fact.input.match(/^((?:AUROC|AUC|C-index|accuracy|F1))\b/i);
  return m?.[1] ?? (fact.type === "value" ? "Value" : null);
}

function answerDisplay(fact: LibraryFact): string {
  if (fact.type === "statement") {
    if (fact.answer === "supported") return "Supported";
    if (fact.answer === "not_supported") return "Not supported";
  }
  return fact.answer || "—";
}

function answerSortValue(fact: LibraryFact): number {
  const n = Number(fact.answer);
  if (Number.isFinite(n)) return n;
  return Number.NEGATIVE_INFINITY;
}

function rectOrient(rect: FactDisplayRect): "h" | "v" {
  if (rect.orient === "v" || rect.orient === "h") return rect.orient;
  return rect.h > rect.w * 1.35 ? "v" : "h";
}

/** Union of same-page rects — vertical table glyphs otherwise jump to one stray digit. */
function primaryRect(fact: PaperFact | LibraryFact): FactDisplayRect | null {
  const rects = fact.displayRects ?? [];
  if (!rects.length) return null;
  const page = fact.highlights?.[0]?.page ?? rects[0]!.page;
  const onPage = rects.filter((r) => r.page === page);
  const use = onPage.length ? onPage : rects;
  const x = Math.min(...use.map((r) => r.x));
  const y = Math.min(...use.map((r) => r.y));
  const right = Math.max(...use.map((r) => r.x + r.w));
  const bottom = Math.max(...use.map((r) => r.y + r.h));
  const merged: FactDisplayRect = {
    page: use[0]!.page,
    x,
    y,
    w: Math.max(1, right - x),
    h: Math.max(1, bottom - y),
  };
  // Prefer an explicit server orient; else vote from children / aspect.
  const votes = use.map((r) => rectOrient(r));
  const vVotes = votes.filter((o) => o === "v").length;
  merged.orient = vVotes > votes.length / 2 ? "v" : rectOrient(merged);
  return merged;
}

function marksForFact(fact: PaperFact | LibraryFact | null): PdfAnnotationMark[] {
  if (!fact) return [];
  const primary = primaryRect(fact);
  if (!primary) return [];
  const model = (fact.input.match(/AUROC of (.+) on/i) || [])[1] || "";
  const vertical = rectOrient(primary) === "v";
  const w = vertical ? Math.max(primary.w, 14) : Math.max(primary.w, 28);
  const h = vertical ? Math.max(primary.h, 22) : Math.max(primary.h, 10);
  return [
    {
      id: `${fact.id}:p${primary.page}`,
      kind: "highlight",
      page: primary.page,
      x: primary.x,
      y: primary.y,
      w,
      h,
      color: "#facc15",
      label: `${model} ${fact.answer}`.trim(),
      selected: true,
      rects: [{ x: primary.x, y: primary.y, w, h }],
    },
  ];
}

function flashForFact(fact: PaperFact | LibraryFact | null): PdfHighlight | null {
  if (!fact) return null;
  const rect = primaryRect(fact);
  if (!rect) return null;
  const model = (fact.input.match(/AUROC of (.+) on/i) || [])[1] || fact.input.slice(0, 24);
  const vertical = rectOrient(rect) === "v";
  if (vertical) {
    return {
      page: rect.page,
      x: Math.max(0, rect.x - 2),
      y: Math.max(0, rect.y - 2),
      width: Math.max(rect.w + 4, 10),
      height: Math.max(rect.h + 4, 14),
      fullWidth: false,
      fullHeight: true,
      label: `${model} · ${fact.answer || "—"}`,
      nonce: Date.now(),
    };
  }
  return {
    page: rect.page,
    x: Math.max(0, rect.x - 3),
    y: Math.max(0, rect.y - 2),
    width: Math.max(rect.w + 6, 28),
    height: Math.max(rect.h + 4, 10),
    // Hug the number cell — full-width bands look like a broken highlight.
    fullWidth: false,
    fullHeight: false,
    label: `${model} · ${fact.answer || "—"}`,
    nonce: Date.now(),
  };
}

function emphasizeAnswer(quote: string, answer: string): { before: string; hit: string; after: string } {
  const needles = [String(answer)];
  const d = Number(answer);
  if (Number.isFinite(d)) {
    needles.push((d * 100).toFixed(2), (d * 100).toFixed(1));
  }
  needles.sort((a, b) => b.length - a.length);
  for (const n of needles) {
    const idx = quote.lastIndexOf(n);
    if (idx < 0) continue;
    return {
      before: quote.slice(0, idx),
      hit: quote.slice(idx, idx + n.length),
      after: quote.slice(idx + n.length),
    };
  }
  return { before: quote, hit: "", after: "" };
}

function readSort(raw: string | null): SortKey {
  if (raw && SORT_OPTIONS.some((o) => o.value === raw)) return raw as SortKey;
  return "paper";
}

function readStatus(raw: string | null): FactStatus | "" {
  if (raw == null) return "unreviewed";
  if (raw === "" || raw === "all") return "";
  if (raw in STATUS_LABEL) return raw as FactStatus;
  return "unreviewed";
}

function readType(raw: string | null): FactType | "" {
  if (raw === "all" || raw === "") return "";
  if (raw && (TYPES as string[]).includes(raw)) return raw as FactType;
  return "value";
}

function sortFacts(list: LibraryFact[], sort: SortKey, dir: "asc" | "desc"): LibraryFact[] {
  const mul = dir === "asc" ? 1 : -1;
  const copy = list.slice();
  copy.sort((a, b) => {
    let cmp = 0;
    switch (sort) {
      case "answer":
        cmp = answerSortValue(a) - answerSortValue(b);
        if (cmp === 0) cmp = a.answer.localeCompare(b.answer);
        break;
      case "subject":
        cmp = factSubject(a).localeCompare(factSubject(b), undefined, { sensitivity: "base" });
        break;
      case "page":
        cmp = (a.highlights[0]?.page ?? 9999) - (b.highlights[0]?.page ?? 9999);
        break;
      case "status":
        cmp = STATUS_RANK[a.status] - STATUS_RANK[b.status];
        break;
      case "updated":
        cmp = a.updatedAt.localeCompare(b.updatedAt);
        break;
      case "paper":
      default:
        cmp = a.citekey.localeCompare(b.citekey);
        if (cmp === 0) cmp = factSubject(a).localeCompare(factSubject(b));
        break;
    }
    if (cmp !== 0) return cmp * mul;
    return a.id.localeCompare(b.id);
  });
  return copy;
}

type PaperGroup = {
  citekey: string;
  title: string;
  facts: LibraryFact[];
};

function groupByPaper(list: LibraryFact[], paperByKey: Map<string, PaperRecord>): PaperGroup[] {
  const order: string[] = [];
  const map = new Map<string, LibraryFact[]>();
  for (const f of list) {
    if (!map.has(f.citekey)) {
      map.set(f.citekey, []);
      order.push(f.citekey);
    }
    map.get(f.citekey)!.push(f);
  }
  return order.map((citekey) => ({
    citekey,
    title: paperByKey.get(citekey)?.title || list.find((f) => f.citekey === citekey)?.paperTitle || citekey,
    facts: map.get(citekey)!,
  }));
}

export function LibraryFactsView({ papers, onBack, onError }: Props) {
  const [params, setParams] = useSearchParams();
  const citekey = params.get("paper") ?? "";
  const type = readType(params.get("type"));
  const status = readStatus(params.get("status"));
  const collection = params.get("collection") ?? "";
  const sort = readSort(params.get("sort"));
  const dir = params.get("dir") === "desc" ? "desc" : "asc";
  const group = params.get("group") === "1";
  const focusFactParam = params.get("fact");
  const qParam = params.get("q") ?? "";

  const [qDraft, setQDraft] = useState(qParam);
  const [rawFacts, setRawFacts] = useState<LibraryFact[]>([]);
  const [busy, setBusy] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [evidenceFact, setEvidenceFact] = useState<PaperFact | LibraryFact | null>(null);
  const [flash, setFlash] = useState<PdfHighlight | null>(null);
  const [snapshotText, setSnapshotText] = useState<string | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [provenanceLabel, setProvenanceLabel] = useState<string | null>(null);
  const snapshotRef = useRef<HTMLPreElement | null>(null);
  const [queueCollapsed, setQueueCollapsed] = useState(
    () => localStorage.getItem("openleaf.facts.queueCollapsed") === "1",
  );
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 900px)").matches : false,
  );
  const [mobilePane, setMobilePane] = useState<"pdf" | "queue">("queue");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [impactNode, setImpactNode] = useState<string | null>(null);
  const [undoFact, setUndoFact] = useState<{ citekey: string; id: string; label: string } | null>(null);
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const paperByKey = useMemo(() => new Map(papers.map((p) => [p.citekey, p])), [papers]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const patchParams = useCallback(
    (patch: Record<string, string | null>, replace = false) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v == null || v === "") next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace },
      );
    },
    [setParams],
  );

  useEffect(() => {
    setQDraft(qParam);
  }, [qParam]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      if (qDraft === qParam) return;
      patchParams({ q: qDraft.trim() || null }, true);
    }, 220);
    return () => window.clearTimeout(t);
  }, [qDraft, qParam, patchParams]);

  const collectionOptions = useMemo(() => {
    const names = new Map<string, string>();
    for (const p of papers) {
      for (const id of p.collections ?? []) {
        if (!names.has(id)) names.set(id, id);
      }
    }
    // Prefer human names from any paper that might carry them via first-seen id.
    return [...names.keys()].sort((a, b) => a.localeCompare(b));
  }, [papers]);

  const papersInCollection = useMemo(() => {
    if (!collection) return null;
    return new Set(papers.filter((p) => p.collections?.includes(collection)).map((p) => p.citekey));
  }, [papers, collection]);

  const toggleQueueCollapsed = () => {
    setQueueCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("openleaf.facts.queueCollapsed", next ? "1" : "0");
      return next;
    });
  };

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      // Pull without status so tabs can show live counts for the same scope.
      const { facts: list } = await listAllLibraryFacts({
        citekey: citekey || undefined,
        type: type || undefined,
        q: qParam.trim() || undefined,
      });
      setRawFacts(list);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Could not load facts");
    } finally {
      setBusy(false);
    }
  }, [citekey, type, qParam, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const scopedFacts = useMemo(() => {
    let list = rawFacts;
    if (papersInCollection) {
      list = list.filter((f) => papersInCollection.has(f.citekey));
    }
    return list;
  }, [rawFacts, papersInCollection]);

  const statusCounts = useMemo(() => {
    const counts: Record<FactStatus | "all", number> = {
      all: scopedFacts.length,
      unreviewed: 0,
      confirmed: 0,
      rejected: 0,
      not_found: 0,
    };
    for (const f of scopedFacts) counts[f.status] += 1;
    return counts;
  }, [scopedFacts]);

  const visibleFacts = useMemo(() => {
    const filtered = status ? scopedFacts.filter((f) => f.status === status) : scopedFacts;
    return sortFacts(filtered, sort, dir);
  }, [scopedFacts, status, sort, dir]);

  const groups = useMemo(
    () => (group ? groupByPaper(visibleFacts, paperByKey) : null),
    [group, visibleFacts, paperByKey],
  );

  const paperOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of scopedFacts) counts.set(f.citekey, (counts.get(f.citekey) ?? 0) + 1);
    const keys = [...counts.keys()].sort((a, b) => a.localeCompare(b));
    // Always include the active paper filter even if it currently has 0 in-scope facts.
    if (citekey && !counts.has(citekey)) keys.unshift(citekey);
    return keys.map((key) => ({
      citekey: key,
      count: counts.get(key) ?? 0,
      title: paperByKey.get(key)?.title ?? key,
    }));
  }, [scopedFacts, citekey, paperByKey]);

  // Deep links (?fact=) must not be hidden by the default unreviewed/value filters.
  useEffect(() => {
    if (!focusFactParam || !scopedFacts.length) return;
    const hit = scopedFacts.find(
      (f) => f.id === focusFactParam || factKey(f) === focusFactParam || f.key === focusFactParam,
    );
    if (!hit) return;
    const patch: Record<string, string | null> = {};
    if (status && hit.status !== status) patch.status = "all";
    if (type && hit.type !== type) patch.type = "all";
    if (Object.keys(patch).length) patchParams(patch, true);
  }, [focusFactParam, scopedFacts, status, type, patchParams]);

  // Keep / restore selection when filters change.
  useEffect(() => {
    if (!visibleFacts.length) {
      setActiveId(null);
      return;
    }
    setActiveId((prev) => {
      if (focusFactParam) {
        const hit = visibleFacts.find(
          (f) => f.id === focusFactParam || factKey(f) === focusFactParam || f.key === focusFactParam,
        );
        if (hit) return factKey(hit);
      }
      if (prev && visibleFacts.some((f) => factKey(f) === prev)) return prev;
      return factKey(visibleFacts[0]!);
    });
  }, [visibleFacts, focusFactParam]);

  const activeFact = useMemo(
    () => visibleFacts.find((f) => factKey(f) === activeId) ?? null,
    [visibleFacts, activeId],
  );
  const activePaper = activeFact ? paperByKey.get(activeFact.citekey) ?? null : null;
  const activeIndex = useMemo(
    () => visibleFacts.findIndex((f) => factKey(f) === activeId),
    [visibleFacts, activeId],
  );

  const selectFact = useCallback(
    (fact: LibraryFact) => {
      const key = factKey(fact);
      setActiveId(key);
      patchParams({ fact: fact.id }, true);
      if (narrow) setMobilePane("pdf");
    },
    [patchParams, narrow],
  );

  const isWebEvidence =
    Boolean(activeFact) &&
    (activeFact!.sourceKind === "web" ||
      activePaper?.source === "web" ||
      (!activePaper?.attachment && Boolean(activePaper?.url)));

  // Load full fact (with displayRects) when selection changes.
  useEffect(() => {
    let cancelled = false;
    if (!activeFact) {
      setEvidenceFact(null);
      setFlash(null);
      return;
    }
    setEvidenceFact(activeFact);
    setFlash(flashForFact(activeFact));
    void listLibraryFacts(activeFact.citekey)
      .then(({ facts: list }) => {
        if (cancelled) return;
        const hit = list.find((f) => f.id === activeFact.id) ?? null;
        if (hit) {
          setEvidenceFact(hit);
          setFlash(flashForFact(hit));
        }
      })
      .catch(() => {
        /* keep list payload */
      });
    return () => {
      cancelled = true;
    };
  }, [activeFact?.citekey, activeFact?.id]);

  // Web sources: load snapshot.txt + provenance, then scroll to the highlighted passage.
  useEffect(() => {
    let cancelled = false;
    if (!activeFact || !isWebEvidence) {
      setSnapshotText(null);
      setSnapshotError(null);
      setProvenanceLabel(null);
      setSnapshotBusy(false);
      return;
    }
    setSnapshotBusy(true);
    setSnapshotError(null);
    setProvenanceLabel(null);
    void Promise.all([
      getLibrarySnapshotText(activeFact.citekey),
      getLibrarySnapshotMeta(activeFact.citekey).catch(() => null),
    ])
      .then(([text, meta]) => {
        if (cancelled) return;
        setSnapshotText(text);
        setProvenanceLabel(meta?.provenanceLabel ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSnapshotText(null);
        setSnapshotError(err instanceof Error ? err.message : "Could not load source snapshot");
      })
      .finally(() => {
        if (!cancelled) setSnapshotBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeFact?.citekey, activeFact?.id, isWebEvidence]);

  useEffect(() => {
    if (!snapshotText || !isWebEvidence) return;
    const el = snapshotRef.current?.querySelector("mark");
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [snapshotText, evidenceFact?.id, isWebEvidence]);

  useEffect(() => {
    if (!activeId) return;
    rowRefs.current.get(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const move = (delta: number) => {
    if (!visibleFacts.length) return;
    const i = activeIndex < 0 ? 0 : activeIndex;
    const next = Math.max(0, Math.min(visibleFacts.length - 1, i + delta));
    selectFact(visibleFacts[next]!);
  };

  const jumpPaper = (delta: number) => {
    if (!visibleFacts.length) return;
    const keys = [...new Set(visibleFacts.map((f) => f.citekey))];
    if (keys.length < 2) return;
    const cur = activeFact?.citekey ?? keys[0]!;
    const idx = Math.max(0, keys.indexOf(cur));
    const nextKey = keys[(idx + delta + keys.length) % keys.length]!;
    const first = visibleFacts.find((f) => f.citekey === nextKey);
    if (first) selectFact(first);
  };

  const decide = async (fact: LibraryFact, next: "confirmed" | "rejected" | "unreviewed") => {
    const key = factKey(fact);
    if (pendingIds.has(key) || fact.status === next) return;
    let rejectReason: string | undefined;
    if (next === "rejected") {
      const reason = window.prompt("Why are you rejecting this fact? (required)", fact.rejectReason || "");
      if (reason == null) return;
      if (!reason.trim()) {
        onError?.("A reason is required when rejecting a fact.");
        return;
      }
      rejectReason = reason.trim();
    }
    setPendingIds((s) => new Set(s).add(key));
    const prevStatus = fact.status;
    setRawFacts((list) =>
      list.map((f) =>
        factKey(f) === key
          ? { ...f, status: next, rejectReason: next === "rejected" ? rejectReason : undefined }
          : f,
      ),
    );
    if (status === "unreviewed" && next !== "unreviewed") {
      const idx = visibleFacts.findIndex((f) => factKey(f) === key);
      const remaining = visibleFacts.filter((f) => factKey(f) !== key);
      if (remaining.length) {
        selectFact(remaining[Math.min(idx, remaining.length - 1)]!);
      } else {
        setActiveId(null);
        patchParams({ fact: null }, true);
      }
    }
    try {
      await patchLibraryFact(fact.citekey, fact.id, {
        status: next,
        ...(rejectReason ? { rejectReason } : {}),
      });
      setUndoFact({ citekey: fact.citekey, id: fact.id, label: fact.input });
      if (next === "rejected" && fact.key) {
        setImpactNode(`fact:${fact.key}`);
      }
    } catch (err) {
      setRawFacts((list) => list.map((f) => (factKey(f) === key ? { ...f, status: prevStatus } : f)));
      onError?.(err instanceof Error ? err.message : "Could not update fact");
    } finally {
      setPendingIds((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  };

  const undoLast = async () => {
    if (!undoFact) return;
    try {
      const res = await patchLibraryFact(undoFact.citekey, undoFact.id, { undoStatus: true });
      setRawFacts((list) =>
        list.map((f) => (f.citekey === undoFact.citekey && f.id === undoFact.id ? { ...f, ...res.fact } : f)),
      );
      setUndoFact(null);
      setImpactNode(null);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Could not undo");
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "Escape" && onBack) {
        e.preventDefault();
        onBack();
        return;
      }
      if (!visibleFacts.length) return;
      const fact = activeIndex >= 0 ? visibleFacts[activeIndex] : visibleFacts[0];
      if (!fact) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "[" || (e.key === "ArrowLeft" && (e.metaKey || e.altKey))) {
        e.preventDefault();
        jumpPaper(-1);
      } else if (e.key === "]" || (e.key === "ArrowRight" && (e.metaKey || e.altKey))) {
        e.preventDefault();
        jumpPaper(1);
      } else if (e.key === "c" || e.key === "y") {
        e.preventDefault();
        void decide(fact, "confirmed");
      } else if (e.key === "x" || e.key === "n") {
        e.preventDefault();
        void decide(fact, "rejected");
      } else if (e.key === "u") {
        e.preventDefault();
        void decide(fact, "unreviewed");
      } else if (e.key === "o" && activeFact) {
        e.preventDefault();
        window.open(libraryPaperUrl(activeFact.citekey), "_blank");
      } else if (e.key === "p" && activeFact) {
        e.preventDefault();
        patchParams({ paper: activeFact.citekey });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visibleFacts, activeIndex, onBack, pendingIds, status, activeFact, patchParams]);

  const marks = useMemo(() => marksForFact(evidenceFact), [evidenceFact]);
  const pdfUrl = activePaper?.attachment ? libraryPdfUrl(activePaper.citekey) : null;

  const filtersActive = Boolean(
    citekey || collection || qParam || (type && type !== "value") || sort !== "paper" || dir !== "asc" || group,
  );

  const clearFilters = () => {
    setQDraft("");
    setParams(
      (prev) => {
        const next = new URLSearchParams();
        // Keep status triage mode unless clearing from All.
        const st = prev.get("status");
        if (st != null) next.set("status", st);
        else next.set("status", "unreviewed");
        next.set("type", "value");
        return next;
      },
      { replace: false },
    );
  };

  const renderFactCard = (f: LibraryFact) => {
    const key = factKey(f);
    const page = f.highlights[0]?.page;
    const quote = f.highlights[0]?.quote;
    const metric = factMetric(f);
    const active = activeId === key;
    const pending = pendingIds.has(key);
    return (
      <li
        key={key}
        ref={(el) => {
          if (el) rowRefs.current.set(key, el);
          else rowRefs.current.delete(key);
        }}
        className={`library-facts-card${active ? " is-active" : ""}${pending ? " is-pending" : ""}`}
        onClick={() => selectFact(f)}
      >
        <div className="library-facts-card-main">
          <div className="library-facts-card-answer" title={answerDisplay(f)}>
            {answerDisplay(f)}
          </div>
          <div className="library-facts-card-body">
            <div className="library-facts-card-subject">
              {metric ? <span className="library-facts-metric">{metric}</span> : null}
              <span className="library-facts-subject">{factSubject(f)}</span>
            </div>
            <div className="library-facts-card-meta muted">
              {!group || narrow ? <span className="library-facts-citekey">{f.citekey}</span> : null}
              {page != null ? <span>p.{page}</span> : null}
              <span className={`library-fact-status is-${f.status}`}>{STATUS_LABEL[f.status]}</span>
            </div>
            {active && quote ? (
              <p className="library-facts-quote muted">
                “{quote.slice(0, 120)}
                {quote.length > 120 ? "…" : ""}”
              </p>
            ) : null}
          </div>
        </div>
      </li>
    );
  };

  const evidenceMeta =
    activeFact && activePaper ? (
      <div className="library-facts-evidence-meta">
        <div>
          <strong className="library-facts-subject">{factSubject(activeFact)}</strong>
          <span className="library-facts-card-answer library-facts-inline-answer">
            {answerDisplay(activeFact)}
          </span>
          {activeFact.key ? (
            <button
              type="button"
              className="btn btn-ghost library-facts-copy-fact"
              title={`Copy \\fact{${activeFact.key}}`}
              onClick={() => void navigator.clipboard.writeText(`\\fact{${activeFact.key}}`)}
            >
              Copy key
            </button>
          ) : null}
        </div>
        <p className="muted">
          {activePaper.title.slice(0, 90)}
          {activePaper.title.length > 90 ? "…" : ""}
          {isWebEvidence ? (
            <> · web source</>
          ) : evidenceFact?.highlights?.[0]?.page != null ? (
            <> · p.{evidenceFact.highlights[0].page}</>
          ) : null}
        </p>
        {isWebEvidence && provenanceLabel ? (
          <p className="library-facts-provenance" title={provenanceLabel}>
            {provenanceLabel}
          </p>
        ) : null}
        {isWebEvidence && activePaper.url ? (
          <p className="library-facts-source-url">
            <a href={activePaper.url} target="_blank" rel="noreferrer">
              {activePaper.url}
            </a>
          </p>
        ) : null}
        <div className="library-facts-evidence-nav">
          <Link
            className="btn btn-ghost"
            to={`/library?paper=${encodeURIComponent(activeFact.citekey)}`}
            title="Open this source in the Library"
          >
            Library
          </Link>
          <button type="button" className="btn btn-ghost" onClick={() => jumpPaper(-1)} title="Previous paper ([)">
            ←
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => jumpPaper(1)} title="Next paper (])">
            →
          </button>
          {activeFact.status !== "not_found" ? (
            <>
              <button
                type="button"
                className="btn btn-primary library-facts-confirm library-facts-decide"
                disabled={pendingIds.has(factKey(activeFact)) || activeFact.status === "confirmed"}
                onClick={() => void decide(activeFact, "confirmed")}
              >
                Confirm
              </button>
              <button
                type="button"
                className="btn btn-danger library-facts-reject library-facts-decide"
                disabled={pendingIds.has(factKey(activeFact)) || activeFact.status === "rejected"}
                onClick={() => void decide(activeFact, "rejected")}
              >
                Reject
              </button>
              {activeFact.previousStatus ? (
                <button type="button" className="btn btn-quiet" onClick={() => void undoLast()}>
                  Undo
                </button>
              ) : null}
            </>
          ) : null}
        </div>
        {activeFact.rejectReason ? (
          <p className="library-facts-reject-reason">Rejected: {activeFact.rejectReason}</p>
        ) : null}
        {evidenceFact?.highlights?.[0]?.quote ? (
          <p className="library-facts-evidence-quote">
            {(() => {
              const parts = emphasizeAnswer(evidenceFact.highlights[0]!.quote, evidenceFact.answer);
              return (
                <>
                  “{parts.before}
                  {parts.hit ? <mark>{parts.hit}</mark> : null}
                  {parts.after}”
                </>
              );
            })()}
          </p>
        ) : (
          <p className="library-facts-evidence-quote muted">
            {isWebEvidence ? "No passage tagged on this snapshot yet." : "No PDF passage linked for this fact."}
          </p>
        )}
      </div>
    ) : null;

  const webSnapshotBody = (() => {
    if (!activeFact || !isWebEvidence) return null;
    if (snapshotBusy) {
      return <div className="library-facts-snapshot-empty muted">Loading source snapshot…</div>;
    }
    if (snapshotError) {
      return (
        <div className="library-facts-snapshot-empty muted">
          <p>{snapshotError}</p>
          <Link to={`/library?paper=${encodeURIComponent(activeFact.citekey)}`}>Open in Library</Link>
        </div>
      );
    }
    if (!snapshotText) {
      return (
        <div className="library-facts-snapshot-empty muted">
          <p>No saved web snapshot for this source.</p>
          <Link to={`/library?paper=${encodeURIComponent(activeFact.citekey)}`}>Open in Library</Link>
        </div>
      );
    }
    const hl = evidenceFact?.highlights?.[0];
    const start = hl?.start ?? -1;
    const end = hl?.end ?? -1;
    const hasRange = start >= 0 && end > start && end <= snapshotText.length;
    return (
      <pre className="library-facts-snapshot" ref={snapshotRef}>
        {hasRange ? (
          <>
            {snapshotText.slice(0, start)}
            <mark>{snapshotText.slice(start, end)}</mark>
            {snapshotText.slice(end)}
          </>
        ) : (
          snapshotText
        )}
      </pre>
    );
  })();

  const evidencePane = !activeFact ? (
    <div className="library-facts-evidence-empty muted">
      <p>Select a fact to read its source beside the queue.</p>
    </div>
  ) : isWebEvidence ? (
    <>
      {evidenceMeta}
      <div className="library-facts-evidence-web">{webSnapshotBody}</div>
    </>
  ) : !activePaper?.attachment ? (
    <div className="library-facts-evidence-empty muted">
      <p>
        <strong>{activeFact.citekey}</strong> has no PDF or web snapshot attached.
      </p>
      {activeFact.highlights[0]?.quote ? (
        <blockquote>“{activeFact.highlights[0].quote}”</blockquote>
      ) : null}
      <p>
        <Link to={`/library?paper=${encodeURIComponent(activeFact.citekey)}`}>Open in Library</Link>
      </p>
    </div>
  ) : (
    <>
      {evidenceMeta}
      <div className="library-facts-evidence-pdf">
        <PdfViewer
          url={pdfUrl!}
          shiftClickHint={null}
          highlight={flash}
          annotations={marks}
          interactionMode="sync"
        />
      </div>
    </>
  );

  const queueList = (
    <div className="library-facts-queue-wrap">
      <div className="library-facts-queue-head">
        <strong>
          {group ? `${groups?.length ?? 0} papers` : "Facts"} · {visibleFacts.length}
        </strong>
        <div className="library-facts-queue-head-actions">
          {activeFact ? (
            <Link
              className="btn btn-ghost"
              to={`/library?paper=${encodeURIComponent(activeFact.citekey)}`}
              title="Open active paper in Library"
            >
              Library
            </Link>
          ) : null}
          {!narrow ? (
            <button
              type="button"
              className="btn btn-ghost btn-icon tree-collapse-btn"
              onClick={toggleQueueCollapsed}
              title="Hide fact queue"
              aria-label="Hide fact queue"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>
      <ul className="library-facts-queue">
        {!visibleFacts.length ? (
          <li className="library-facts-empty empty-hint-card">
            {busy ? (
              <p className="muted">Loading facts…</p>
            ) : status === "unreviewed" ? (
              <>
                <strong>Nothing left to check here</strong>
                <p>
                  Every fact in this filter is confirmed or rejected. Switch to{" "}
                  <button type="button" className="btn btn-quiet" onClick={() => patchParams({ status: "all" })}>
                    All statuses
                  </button>{" "}
                  to browse the library, or open the{" "}
                  <Link to="/review">Review inbox</Link> for steps and flagged items.
                </p>
              </>
            ) : (
              <>
                <strong>No facts match these filters</strong>
                <p>Clear the search or widen status / type to see more.</p>
              </>
            )}
          </li>
        ) : null}
        {groups
          ? groups.map((g) => (
              <li key={`group:${g.citekey}`} className="library-facts-group">
                <div className="library-facts-group-head">
                  <button
                    type="button"
                    className="library-facts-group-cite"
                    onClick={() => {
                      patchParams({ paper: g.citekey });
                      if (g.facts[0]) selectFact(g.facts[0]);
                    }}
                    title={`Filter to ${g.citekey}`}
                  >
                    {g.citekey}
                  </button>
                  <span className="library-facts-group-count">{g.facts.length}</span>
                  <div className="library-facts-group-actions">
                    <Link
                      className="btn btn-ghost"
                      to={`/library?paper=${encodeURIComponent(g.citekey)}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      Library
                    </Link>
                  </div>
                </div>
                <p className="library-facts-group-paper muted" title={g.title}>
                  {g.title}
                </p>
                <ul className="library-facts-group-list">{g.facts.map(renderFactCard)}</ul>
              </li>
            ))
          : visibleFacts.map(renderFactCard)}
      </ul>
    </div>
  );

  const bodyClass = [
    "library-facts-workspace-body",
    queueCollapsed && !narrow ? "is-queue-collapsed" : "",
    narrow ? (mobilePane === "pdf" ? "is-mobile-pdf" : "is-mobile-queue") : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="library-facts-workspace">
      <header className="library-facts-workspace-head">
        <div className="library-facts-workspace-title">
          {onBack ? (
            <button type="button" className="btn btn-ghost" onClick={onBack}>
              ← Library
            </button>
          ) : null}
          <div>
            <h2 title="j/k move · [/] paper · c confirm · x reject">Facts</h2>
            <p className="muted">
              {status === "unreviewed"
                ? `${visibleFacts.length} to review`
                : `${visibleFacts.length} shown`}
              {busy ? " ·…" : null}
            </p>
          </div>
        </div>
      </header>

      <div className="library-facts-toolbar">
        <div className="library-facts-toolbar-row is-primary">
          <input
            className="library-search"
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            placeholder="Search facts…"
            aria-label="Search facts"
          />
          <div className="library-facts-status-tabs" role="tablist" aria-label="Fact status">
            {STATUSES.map((s) => {
              const count = s ? statusCounts[s] : statusCounts.all;
              return (
                <button
                  key={s || "all"}
                  type="button"
                  role="tab"
                  aria-selected={status === s}
                  className={`library-facts-status-tab${status === s ? " is-active" : ""}`}
                  onClick={() =>
                    patchParams({
                      status: s === "" ? "all" : s,
                      fact: null,
                    })
                  }
                >
                  {s ? STATUS_LABEL[s] : "All"}
                  <span className="library-facts-tab-count">{count}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className={`btn btn-ghost${filtersOpen || filtersActive ? " is-active" : ""}`}
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((v) => !v)}
          >
            Filters{filtersActive ? " ·" : ""}
          </button>
        </div>
        {filtersOpen ? (
          <div className="library-facts-toolbar-row">
            <label className="library-facts-field">
              <span>Paper</span>
              <select
                value={citekey}
                onChange={(e) => patchParams({ paper: e.target.value || null, fact: null })}
              >
                <option value="">All ({statusCounts.all})</option>
                {paperOptions.map((p) => (
                  <option key={p.citekey} value={p.citekey}>
                    {p.citekey} ({p.count})
                  </option>
                ))}
              </select>
            </label>
            {collectionOptions.length ? (
              <label className="library-facts-field">
                <span>Collection</span>
                <select
                  value={collection}
                  onChange={(e) => patchParams({ collection: e.target.value || null, fact: null })}
                >
                  <option value="">All</option>
                  {collectionOptions.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="library-facts-field">
              <span>Type</span>
              <select
                value={type}
                onChange={(e) => patchParams({ type: e.target.value || null, fact: null })}
              >
                {TYPES.map((t) => (
                  <option key={t || "all"} value={t}>
                    {t || "All"}
                  </option>
                ))}
              </select>
            </label>
            <label className="library-facts-field">
              <span>Sort</span>
              <select
                value={sort}
                onChange={(e) => patchParams({ sort: e.target.value === "paper" ? null : e.target.value })}
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="library-facts-toolbar-actions">
              <button
                type="button"
                className={`btn btn-ghost${dir === "desc" ? " is-active" : ""}`}
                title={dir === "asc" ? "Ascending" : "Descending"}
                onClick={() => patchParams({ dir: dir === "asc" ? "desc" : null })}
              >
                {dir === "asc" ? "Asc" : "Desc"}
              </button>
              <button
                type="button"
                className={`btn btn-ghost${group ? " is-active" : ""}`}
                title="Group queue by paper"
                aria-pressed={group}
                onClick={() => patchParams({ group: group ? null : "1" })}
              >
                Group
              </button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void refresh()}>
                Refresh
              </button>
              {filtersActive ? (
                <button type="button" className="btn btn-ghost" onClick={clearFilters}>
                  Clear
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {narrow ? (
        <div className="library-facts-mobile-tabs" role="tablist" aria-label="Facts pane">
          <button
            type="button"
            className={`btn btn-ghost${mobilePane === "queue" ? " is-active" : ""}`}
            aria-selected={mobilePane === "queue"}
            onClick={() => setMobilePane("queue")}
          >
            Queue ({visibleFacts.length})
          </button>
          <button
            type="button"
            className={`btn btn-ghost${mobilePane === "pdf" ? " is-active" : ""}`}
            aria-selected={mobilePane === "pdf"}
            onClick={() => setMobilePane("pdf")}
            disabled={!activeFact}
          >
            Evidence
          </button>
        </div>
      ) : null}

      <div className={bodyClass}>
        {narrow ? (
          <div className="library-facts-workspace-split" style={{ display: "flex", width: "100%" }}>
            <aside className="library-facts-evidence library-facts-evidence-pane" aria-label="PDF evidence">
              {evidencePane}
            </aside>
            <div className="library-facts-queue-pane">{queueList}</div>
          </div>
        ) : queueCollapsed ? (
          <div className="library-facts-workspace-split">
            <aside className="library-facts-evidence" aria-label="PDF evidence">
              {evidencePane}
            </aside>
            <button
              type="button"
              className="btn btn-ghost library-facts-queue-rail"
              onClick={toggleQueueCollapsed}
              title="Show fact queue"
              aria-label="Show fact queue"
            >
              Facts
            </button>
          </div>
        ) : (
          <SplitPane
            className="library-facts-workspace-split"
            storageKey="openleaf.facts.split"
            initialLeftRatio={0.62}
            minLeft={280}
            minRight={260}
            leftClassName="library-facts-evidence-pane"
            rightClassName="library-facts-queue-pane"
            left={
              <aside className="library-facts-evidence" aria-label="PDF evidence">
                {evidencePane}
              </aside>
            }
            right={queueList}
          />
        )}
      </div>
      {undoFact ? (
        <div className="library-facts-undo-bar" role="status">
          <span>Updated “{undoFact.label}”.</span>
          <button type="button" className="btn btn-quiet" onClick={() => void undoLast()}>
            Undo
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setUndoFact(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      <KnowledgeImpactPanel nodeId={impactNode} onClose={() => setImpactNode(null)} />
    </div>
  );
}
