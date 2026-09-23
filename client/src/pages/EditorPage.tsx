import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useParams } from "react-router-dom";
import type * as Y from "yjs";
import {
  checkoutProjectTimeline,
  compileProject,
  commitProjectTimeline,
  createProjectFile,
  deleteProjectPath,
  downloadUrl,
  getConfig,
  getDiffHighlights,
  getProject,
  getProjectMerge,
  getProjectTimeline,
  getTree,
  generateTrackChanges,
  listProjectComments,
  mkdirProjectPath,
  pdfUrl,
  trackChangesPdfUrl,
  readProjectFile,
  renameProjectPath,
  synctexForward,
  synctexLookup,
  trackChangesDownloadUrl,
  writeProjectFile,
  type MergeSession,
} from "../api/client";
import type { AppConfig, FileChangeDiff, GitCommitInfo, ProjectMeta, TimelineView, TreeNode } from "../api/types";
import { guestLogout, hostLogout, listProjectAiReview, acceptAiReview, rejectAiReview, type AiReviewCollaborator, type AiReviewHunk } from "../api/share";
import { flushCollab, useProjectCollab } from "../collab/useProjectCollab";
import { BinaryPane } from "../components/BinaryPane";
import { BranchTreePanel } from "../components/BranchTreePanel";
import { CodeEditor, type EditorChangeMarks, type EditorSuggestionMark } from "../components/CodeEditor";
import { CompareBaselinePicker } from "../components/CompareBaselinePicker";
import { CompileLog } from "../components/CompileLog";
import { FileTree } from "../components/FileTree";
import { CommentsPanel, type CommentDraft } from "../components/CommentsPanel";
import { AiReviewPanel } from "../components/AiReviewPanel";
import { AiLinkPanel } from "../components/AiLinkPanel";
import { AiSuggestionCard } from "../components/AiSuggestionCard";
import { isAiBranch } from "../components/timelineLayout";
import { MergePanel } from "../components/MergePanel";
import { PdfViewer, type PdfDiffOverlay, type PdfHighlight } from "../components/PdfViewer";
import { SharePanel } from "../components/SharePanel";
import { SplitPane } from "../components/SplitPane";
import { ThemePicker } from "../components/ThemeToggle";
import { extractCitations, extractLabels } from "../latex/completions";
import type { CommentAnchor, CommentThread, TimelineBranch, TimelineNode } from "../api/types";
import { useGuest, useSession } from "../session/SessionContext";
import { useMediaQuery } from "../hooks/useMediaQuery";

type Status = "idle" | "dirty" | "saving" | "compiling" | "ok" | "err";
type EditMode = "text" | "binary" | "base64";

function flattenFiles(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type === "file") out.push(n.path);
    else if (n.children) out.push(...flattenFiles(n.children));
  }
  return out;
}

function flattenReviewHunks(collabs: AiReviewCollaborator[]): { collab: AiReviewCollaborator; hunk: AiReviewHunk }[] {
  const out: { collab: AiReviewCollaborator; hunk: AiReviewHunk }[] = [];
  for (const c of collabs) {
    for (const f of c.files) {
      for (const h of f.hunks) out.push({ collab: c, hunk: h });
    }
  }
  return out;
}

function hunkAnchor(hunk: AiReviewHunk): CommentAnchor {
  const range = hunk.ranges?.[0];
  return {
    file: hunk.path,
    line: range?.startLine ?? Math.max(1, hunk.newStart || 1),
    column: range?.startColumn ?? 1,
  };
}

function findAiHunk(collabs: AiReviewCollaborator[], hunkId: string | null) {
  if (!hunkId) return null;
  for (const collab of collabs) {
    for (const file of collab.files) {
      const hunk = file.hunks.find((h) => h.id === hunkId);
      if (hunk) return { collab, file, hunk };
    }
  }
  return null;
}

function parentDir(filePath: string | null): string {
  if (!filePath) return "";
  const i = filePath.lastIndexOf("/");
  return i >= 0 ? filePath.slice(0, i) : "";
}

function joinPath(dir: string, name: string): string {
  const clean = name.replace(/^\/+/, "").replace(/\\/g, "/");
  return dir ? `${dir}/${clean}` : clean;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function isHintIndexPath(filePath: string): boolean {
  return !filePath.split("/").some(
    (p) => p === ".openleaf" || p === "data" || p === "private" || p === "tmp" || p === "vendor",
  );
}

function diffHighlightKey(projectId: string): string {
  return `openleaf.diffHighlight.${projectId}`;
}

function persistDiffHighlight(
  projectId: string,
  enabled: boolean,
  since: string,
  label?: string,
  trackChangesPdf?: boolean,
): void {
  localStorage.setItem(
    diffHighlightKey(projectId),
    JSON.stringify({
      enabled,
      since: since || null,
      label: label || null,
      trackChangesPdf: Boolean(trackChangesPdf),
    }),
  );
}

function readDiffHighlightPref(projectId: string): {
  enabled: boolean;
  since: string;
  label: string;
  trackChangesPdf: boolean;
} {
  try {
    const raw = localStorage.getItem(diffHighlightKey(projectId));
    if (!raw) return { enabled: false, since: "", label: "", trackChangesPdf: false };
    const pref = JSON.parse(raw) as {
      enabled?: boolean;
      since?: string | null;
      label?: string | null;
      trackChangesPdf?: boolean;
    };
    return {
      enabled: Boolean(pref.enabled),
      since: typeof pref.since === "string" ? pref.since : "",
      label: typeof pref.label === "string" ? pref.label : "",
      trackChangesPdf: Boolean(pref.trackChangesPdf),
    };
  } catch {
    return { enabled: false, since: "", label: "", trackChangesPdf: false };
  }
}

function shortBaselineLabel(message: string, hash: string, max = 36): string {
  const msg = message.trim().replace(/\s+/g, " ");
  const short = hash.slice(0, 7);
  if (!msg) return short;
  return msg.length <= max ? `${short} · ${msg}` : `${short} · ${msg.slice(0, max - 1)}…`;
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function formatLastSaved(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatShareLeft(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${pad(h)}:${pad(m)}:${pad(sec)}`;
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function normDiffPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function EditorPage() {
  const { id = "" } = useParams();
  const guest = useGuest();
  const { session, refresh: refreshSession } = useSession();
  const isRemoteHost = session.kind === "host" && session.remote;
  const narrow = useMediaQuery("(max-width: 720px)");
  const [mobilePane, setMobilePane] = useState<"files" | "source" | "preview">("source");
  const guestIdentity = useMemo(
    () => (guest ? { id: guest.guest.id, name: guest.guest.name, color: guest.guest.color } : null),
    [guest?.guest.id, guest?.guest.name, guest?.guest.color],
  );
  const isGuest = guest !== null;
  const readOnly = guest?.share.readOnly ?? false;
  const canCompile = !guest || guest.share.allowCompile;
  const canDownload = !guest || guest.share.allowDownload;
  const canHistory = !guest || guest.share.allowHistory;
  const guestBranchId = guest?.share.branchId ?? null;
  const [branchId, setBranchId] = useState(guestBranchId || "main");
  const branchIdRef = useRef(branchId);
  branchIdRef.current = branchId;
  const [timelineCanEdit, setTimelineCanEdit] = useState(true);
  const [viewingGitHash, setViewingGitHash] = useState<string | null>(null);
  const viewingGitHashRef = useRef(viewingGitHash);
  viewingGitHashRef.current = viewingGitHash;
  const [branchLabel, setBranchLabel] = useState(guest?.share.branchName || "main");
  const [project, setProject] = useState<ProjectMeta | null>(null);
  const collab = useProjectCollab(project?.id === id ? id || undefined : undefined, guestIdentity, branchId);
  const [shareOpen, setShareOpen] = useState(false);
  const [aiLinksOpen, setAiLinksOpen] = useState(false);
  const [shareActive, setShareActive] = useState(false);
  const [shareCount, setShareCount] = useState(0);
  const [aiLinkCount, setAiLinkCount] = useState(0);
  const [shareExpiresAt, setShareExpiresAt] = useState<number | null | undefined>(undefined);
  const [shareTimerLabel, setShareTimerLabel] = useState("Live link");
  const [shareUrgent, setShareUrgent] = useState(false);
  const shareExpiresAtRef = useRef(shareExpiresAt);
  shareExpiresAtRef.current = shareExpiresAt;

  const onShareStatus = useCallback((info: { active: boolean; count?: number; expiresAt: number | null | undefined }) => {
    setShareActive(info.active);
    setShareCount(info.count ?? (info.active ? 1 : 0));
    setShareExpiresAt(info.expiresAt);
  }, []);

  // Drive the toolbar label from an interval so it visibly ticks even if other
  // state updates are batched or bailed out.
  useEffect(() => {
    if (!shareActive) {
      setShareTimerLabel("Live link");
      setShareUrgent(false);
      return;
    }
    const tick = () => {
      const exp = shareExpiresAtRef.current;
      if (exp === null) {
        setShareTimerLabel("Live · no expiry");
        setShareUrgent(false);
        return;
      }
      if (exp === undefined) {
        setShareTimerLabel("Live link");
        setShareUrgent(false);
        return;
      }
      const left = exp - Date.now();
      setShareTimerLabel(`Live · ${formatShareLeft(left)}`);
      setShareUrgent(left < 5 * 60_000);
    };
    tick();
    const t = window.setInterval(tick, 250);
    return () => window.clearInterval(t);
  }, [shareActive, shareExpiresAt]);

  const [config, setConfig] = useState<AppConfig | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [yText, setYText] = useState<Y.Text | null>(null);
  const [liveContent, setLiveContent] = useState("");
  const [editMode, setEditMode] = useState<EditMode>("text");
  const [binaryMeta, setBinaryMeta] = useState<{
    contentType: string;
    size: number;
    base64: string;
  } | null>(null);
  const [log, setLog] = useState("");
  const [logOpen, setLogOpen] = useState(() =>
    typeof window === "undefined" ? true : !window.matchMedia("(max-width: 720px)").matches,
  );
  const [status, setStatus] = useState<Status>("idle");
  const [pdfBust, setPdfBust] = useState<number | null>(null);
  const [pdfSwitching, setPdfSwitching] = useState(false);
  const previewEpochRef = useRef(0);
  const [pdfNav, setPdfNav] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [citations, setCitations] = useState<string[]>([]);
  const [extraLabels, setExtraLabels] = useState<string[]>([]);
  const [treeWidth, setTreeWidth] = useState(() => {
    const n = Number(localStorage.getItem("openleaf.treeWidth") ?? 240);
    return Number.isFinite(n) ? Math.min(420, Math.max(160, n)) : 240;
  });
  const treeWidthRef = useRef(treeWidth);
  treeWidthRef.current = treeWidth;
  const [treeCollapsed, setTreeCollapsed] = useState(
    () => localStorage.getItem("openleaf.treeCollapsed") === "1",
  );
  const [treeDragging, setTreeDragging] = useState(false);
  const [jumpTo, setJumpTo] = useState<{
    path?: string;
    line: number;
    column: number;
    nonce?: number;
  } | null>(null);
  const pendingJumpRef = useRef<{
    path: string;
    line: number;
    column: number;
  } | null>(null);
  const [pdfHighlight, setPdfHighlight] = useState<PdfHighlight | null>(null);
  const [syncToast, setSyncToast] = useState<string | null>(null);
  const [forceTextPath, setForceTextPath] = useState<string | null>(null);
  const [forceBase64Path, setForceBase64Path] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeSession, setMergeSession] = useState<MergeSession | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [aiReviewOpen, setAiReviewOpen] = useState(false);
  const [aiReviewCount, setAiReviewCount] = useState(0);
  const [aiCollabs, setAiCollabs] = useState<AiReviewCollaborator[]>([]);
  const [aiActiveId, setAiActiveId] = useState<string | null>(null);
  const [aiFocusBranchId, setAiFocusBranchId] = useState<string | null>(null);
  const [aiFocusNonce, setAiFocusNonce] = useState(0);
  const [aiPopupBusy, setAiPopupBusy] = useState(false);
  const [toolbarMoreOpen, setToolbarMoreOpen] = useState(false);
  const toolbarMoreRef = useRef<HTMLDivElement>(null);
  const toolbarMoreBtnRef = useRef<HTMLButtonElement>(null);
  const toolbarMenuRef = useRef<HTMLDivElement>(null);
  const [toolbarMenuBox, setToolbarMenuBox] = useState<{
    top: number;
    right: number;
    maxHeight: number;
  } | null>(null);

  const closeOverlappingChrome = useCallback((keep?: "history" | "comments" | "ai" | "share" | "aiLinks") => {
    setToolbarMoreOpen(false);
    if (keep !== "history") setHistoryOpen(false);
    if (keep !== "comments") setCommentsOpen(false);
    if (keep !== "ai") setAiReviewOpen(false);
    if (keep !== "share") setShareOpen(false);
    if (keep !== "aiLinks") setAiLinksOpen(false);
  }, []);
  const [commitBusy, setCommitBusy] = useState(false);
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [commentThreads, setCommentThreads] = useState<CommentThread[]>([]);
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null);
  const [lastCommit, setLastCommit] = useState<string | null>(null);
  const [tipGitHash, setTipGitHash] = useState<string | null>(null);
  const [trackChangesBusy, setTrackChangesBusy] = useState(false);
  const pendingTrackChangesRef = useRef(false);
  const trackChangesBusyCount = useRef(0);
  const trackChangesPreviewReqRef = useRef("");
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [flushedContent, setFlushedContent] = useState("");
  const saveLock = useRef(false);
  const [diffOn, setDiffOn] = useState(false);
  const [diffSince, setDiffSince] = useState("");
  const [diffBaselineLabel, setDiffBaselineLabel] = useState("");
  const [comparePickerOpen, setComparePickerOpen] = useState(false);
  const [diffBoxes, setDiffBoxes] = useState<PdfDiffOverlay[]>([]);
  const [diffLines, setDiffLines] = useState<number | null>(null);
  const [diffFiles, setDiffFiles] = useState<number | null>(null);
  const [diffAdditions, setDiffAdditions] = useState<number | null>(null);
  const [diffDeletions, setDiffDeletions] = useState<number | null>(null);
  const [diffChanges, setDiffChanges] = useState<FileChangeDiff[]>([]);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffWarning, setDiffWarning] = useState<string | null>(null);
  const [trackChangesPreviewOn, setTrackChangesPreviewOn] = useState(false);
  const [trackChangesPreviewPair, setTrackChangesPreviewPair] = useState<{
    from: string;
    to: string;
  } | null>(null);
  const [trackChangesPreviewBust, setTrackChangesPreviewBust] = useState<number | null>(null);
  const [trackChangesPreviewError, setTrackChangesPreviewError] = useState<string | null>(null);
  const compileLock = useRef(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const aiCollabsRef = useRef(aiCollabs);
  aiCollabsRef.current = aiCollabs;
  const consumedAiFocusNonce = useRef(0);
  const [fileReady, setFileReady] = useState(false);
  const [tooLargeBytes, setTooLargeBytes] = useState<number | null>(null);

  const collabText = editMode === "text" && yText != null && !viewingGitHash && timelineCanEdit;
  const dirty =
    !readOnly &&
    timelineCanEdit &&
    !viewingGitHash &&
    editMode !== "binary" &&
    fileReady &&
    (collabText ? liveContent !== flushedContent : content !== savedContent);

  useLayoutEffect(() => {
    if (!toolbarMoreOpen) {
      setToolbarMenuBox(null);
      return;
    }
    const place = () => {
      const btn = toolbarMoreBtnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const top = r.bottom + 6;
      setToolbarMenuBox({
        top,
        right: Math.max(8, window.innerWidth - r.right),
        maxHeight: Math.max(160, window.innerHeight - top - 12),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [toolbarMoreOpen]);

  useEffect(() => {
    if (!toolbarMoreOpen) return;
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node;
      const el = e.target as HTMLElement | null;
      if (toolbarMoreRef.current?.contains(t) || toolbarMenuRef.current?.contains(t)) return;
      if (el?.closest(".theme-picker-menu")) return;
      setToolbarMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setToolbarMoreOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [toolbarMoreOpen]);

  const refreshTree = useCallback(async () => {
    if (!id) return;
    setTree(await getTree(id, viewingGitHash, viewingGitHash ? null : branchId));
  }, [id, viewingGitHash, branchId]);

  const loadIndexHints = useCallback(async (projectId: string, nodes: TreeNode[]) => {
    const files = flattenFiles(nodes).filter(isHintIndexPath);
    const bibPaths = files.filter((f) => f.endsWith(".bib"));
    const texPaths = files.filter((f) => f.endsWith(".tex"));
    const bibTexts = await Promise.all(
      bibPaths.map(async (f) => {
        try {
          const file = await readProjectFile(projectId, f, { forceText: true });
          return file.contentOmitted ? "" : file.content;
        } catch {
          return "";
        }
      }),
    );
    const citeKeys = new Set<string>();
    for (const text of bibTexts) {
      for (const key of extractCitations(text)) citeKeys.add(key);
    }
    setCitations([...citeKeys].sort());

    const labelKeys = new Set<string>();
    for (const f of texPaths) {
      try {
        const file = await readProjectFile(projectId, f, { forceText: true });
        if (file.contentOmitted) continue;
        for (const key of extractLabels(file.content)) labelKeys.add(key);
      } catch {
        /* ignore */
      }
    }
    setExtraLabels([...labelKeys].sort());
  }, []);

  useEffect(() => {
    if (!id) return;
    setError(null);
    (async () => {
      try {
        // Guests cannot read the server config (host-only); defaults apply.
        const p = await getProject(id);
        const [t, cfg] = await Promise.all([getTree(id, null, guestBranchId || "main"), isGuest ? null : getConfig()]);
        setProject(p);
        setTree(t);
        setConfig(cfg);
        setActivePath(p.mainFile);
        await loadIndexHints(id, t);
      } catch (err) {
        setProject(null);
        setError(err instanceof Error ? err.message : "Failed to open project");
      }
    })();
  }, [id, loadIndexHints, isGuest]);

  // Refresh tree when remote FS ops bump treeVersion
  useEffect(() => {
    if (!collab.treeVersion) return;
    void refreshTree();
  }, [collab.treeVersion, refreshTree]);

  // Binary / oversized files are not in the CRDT — reload the open file from disk
  // when the watcher reports that path changed. Collaborative text updates live.
  useEffect(() => {
    if (!id || !activePath || collabText || dirty) return;
    if (!collab.treeEventPaths.includes(activePath)) return;
    let cancelled = false;
    const pathBeingLoaded = activePath;
    (async () => {
      try {
        const forceText = forceTextPath === pathBeingLoaded;
        const file = await readProjectFile(id, pathBeingLoaded, { forceText, branchId });
        if (cancelled || activePathRef.current !== pathBeingLoaded) return;
        if (!file.text && !forceText) {
          setEditMode("binary");
          setBinaryMeta({
            contentType: file.contentType,
            size: file.size,
            base64: file.content,
          });
          return;
        }
        setContent(file.content);
        setSavedContent(file.content);
      } catch {
        /* ignore — the next explicit open will surface the error */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, activePath, collab.treeEventPaths, collabText, dirty, forceTextPath]);

  // Keep gutter marks / toolbar count fresh (panel may be closed)
  useEffect(() => {
    if (!id || project?.id !== id) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await listProjectComments(id);
        if (!cancelled) setCommentThreads(list);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, project?.id, collab.commentsVersion]);

  useEffect(() => {
    if (!id || isGuest || project?.id !== id) {
      setAiReviewCount(0);
      setAiCollabs([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await listProjectAiReview(id);
        if (!cancelled) {
          setAiReviewCount(data.hunkCount);
          setAiCollabs(data.collaborators);
        }
      } catch {
        if (!cancelled) setAiReviewCount(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, isGuest, project?.id, collab.aiReviewVersion]);

  useEffect(() => {
    if (!id || isGuest || project?.id !== id) return;
    const t = window.setInterval(() => {
      void listProjectAiReview(id)
        .then((data) => {
          setAiReviewCount(data.hunkCount);
          setAiCollabs(data.collaborators);
        })
        .catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(t);
  }, [id, isGuest, project?.id]);

  useEffect(() => {
    if (!id) {
      setDiffOn(false);
      setDiffSince("");
      setDiffBaselineLabel("");
      setTrackChangesPreviewOn(false);
      setTrackChangesPreviewPair(null);
      setTrackChangesPreviewError(null);
      setTrackChangesPreviewBust(null);
      trackChangesPreviewReqRef.current = "";
      return;
    }
    const pref = readDiffHighlightPref(id);
    setDiffOn(pref.enabled);
    setDiffSince(pref.since);
    setDiffBaselineLabel(pref.label);
    setTrackChangesPreviewOn(pref.trackChangesPdf);
    setTrackChangesPreviewPair(null);
    setTrackChangesPreviewError(null);
    setTrackChangesPreviewBust(null);
    trackChangesPreviewReqRef.current = "";
  }, [id]);

  useEffect(() => {
    if (!id || !diffOn) return;
    if (!diffSince) setComparePickerOpen(true);
  }, [id, diffOn, diffSince]);

  // Soft refresh after quiet period (flush/tree bumps). Hard deps fetch immediately.
  const [diffRefreshNonce, setDiffRefreshNonce] = useState(0);
  useEffect(() => {
    if (!id || !diffOn) return;
    const t = window.setTimeout(() => setDiffRefreshNonce((n) => n + 1), 1100);
    return () => window.clearTimeout(t);
  }, [id, diffOn, pdfBust, collab.treeVersion, collab.leavesVersion, flushedContent]);

  const diffFetchGen = useRef(0);
  useEffect(() => {
    if (!id || !diffOn) {
      diffFetchGen.current += 1;
      setDiffBoxes([]);
      setDiffLines(null);
      setDiffFiles(null);
      setDiffAdditions(null);
      setDiffDeletions(null);
      setDiffChanges([]);
      setDiffWarning(null);
      setDiffLoading(false);
      return;
    }
    if (!diffSince) {
      // Waiting for commit list to pick a baseline — keep prior marks if any.
      return;
    }

    const gen = ++diffFetchGen.current;
    let cancelled = false;
    setDiffLoading(true);
    void (async () => {
      try {
        const result = await getDiffHighlights(id, diffSince, branchId, viewingGitHash);
        if (cancelled || gen !== diffFetchGen.current) return;
        setDiffBoxes(result.boxes);
        setDiffLines(result.lines);
        setDiffFiles(result.files);
        setDiffAdditions(result.additions ?? result.lines);
        setDiffDeletions(result.deletions ?? 0);
        setDiffChanges(result.changes ?? []);
        setDiffWarning(result.warning ?? null);
      } catch (err) {
        if (cancelled || gen !== diffFetchGen.current) return;
        setDiffBoxes([]);
        setDiffLines(null);
        setDiffFiles(null);
        setDiffAdditions(null);
        setDiffDeletions(null);
        setDiffChanges([]);
        setDiffWarning(err instanceof Error ? err.message : "Could not load changes");
      } finally {
        if (!cancelled && gen === diffFetchGen.current) setDiffLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, diffOn, diffSince, branchId, viewingGitHash, diffRefreshNonce]);

  const fileChangeMap = useMemo(() => {
    if (!diffOn || !diffChanges.length) return null;
    const map: Record<string, { status: FileChangeDiff["status"]; additions: number; deletions: number }> = {};
    for (const c of diffChanges) {
      map[c.file] = { status: c.status, additions: c.additions, deletions: c.deletions };
      map[normDiffPath(c.file)] = { status: c.status, additions: c.additions, deletions: c.deletions };
    }
    return map;
  }, [diffOn, diffChanges]);

  const changeMarks: EditorChangeMarks = useMemo(() => {
    if (!diffOn || !activePath) return null;
    const want = normDiffPath(activePath);
    const entry =
      diffChanges.find((c) => c.file === activePath) ??
      diffChanges.find((c) => normDiffPath(c.file) === want);
    if (!entry) return null;
    return {
      addedLines: entry.addedLines,
      deletedHunks: entry.deletedHunks,
      deletedFile: entry.status === "deleted",
    };
  }, [diffOn, activePath, diffChanges]);

  const suggestionMarks: EditorSuggestionMark[] = useMemo(() => {
    if (!activePath) return [];
    const out: EditorSuggestionMark[] = [];
    for (const c of aiCollabs) {
      if (c.branchId !== branchId) continue;
      for (const f of c.files) {
        if (f.path !== activePath) continue;
        for (const h of f.hunks) {
          for (const r of h.ranges ?? []) {
            out.push({
              id: h.id,
              startLine: r.startLine,
              startColumn: r.startColumn,
              endLine: r.endLine,
              endColumn: r.endColumn,
            });
          }
        }
      }
    }
    return out;
  }, [aiCollabs, activePath, branchId]);

  const activeAiHit = findAiHunk(aiCollabs, aiActiveId);
  const reviewHunks = useMemo(() => flattenReviewHunks(aiCollabs), [aiCollabs]);
  const reviewNavIndex = reviewHunks.findIndex((x) => x.hunk.id === aiActiveId);

  const onAiCollabsChange = useCallback((next: AiReviewCollaborator[]) => {
    setAiCollabs(next);
  }, []);

  const reopenAiLeafNotifications = useCallback((branch: TimelineBranch) => {
    if (isGuest || !isAiBranch(branch)) return;
    closeOverlappingChrome("ai");
    setAiReviewOpen(!narrow);
    if (narrow) setMobilePane("source");
    setAiFocusBranchId(branch.id);
    setAiFocusNonce((n) => n + 1);
  }, [isGuest, narrow, closeOverlappingChrome]);

  const activeChangeHint =
    activePath && fileChangeMap
      ? fileChangeMap[activePath] ?? fileChangeMap[normDiffPath(activePath)] ?? null
      : null;
  const viewingDeletedFile = Boolean(activeChangeHint?.status === "deleted");
  const deletedSnapshotAt = viewingDeletedFile && diffSince ? diffSince : null;
  const onDiffEnabledChange = useCallback(
    (on: boolean) => {
      setDiffOn(on);
      if (id) persistDiffHighlight(id, on, diffSince, diffBaselineLabel, trackChangesPreviewOn);
      if (on && !diffSince) setComparePickerOpen(true);
      if (!on) setComparePickerOpen(false);
    },
    [id, diffSince, diffBaselineLabel, trackChangesPreviewOn],
  );

  const onTrackChangesPreviewChange = useCallback(
    (on: boolean) => {
      setTrackChangesPreviewOn(on);
      if (id) persistDiffHighlight(id, diffOn, diffSince, diffBaselineLabel, on);
      if (on && !diffSince) setComparePickerOpen(true);
    },
    [id, diffOn, diffSince, diffBaselineLabel],
  );

  const labels = useMemo(() => {
    const textForLabels = collabText ? liveContent : content;
    const set = new Set([...extraLabels, ...extractLabels(textForLabels)]);
    return [...set].sort();
  }, [extraLabels, content, liveContent, collabText]);

  useEffect(() => {
    if (!yText) {
      setLiveContent("");
      return;
    }
    const sync = () => setLiveContent(yText.toString());
    sync();
    yText.observe(sync);
    return () => yText.unobserve(sync);
  }, [yText]);

  const lastTextPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!id || !activePath) return;
    let cancelled = false;
    const pathBeingLoaded = activePath;
    const pathChanged = lastTextPathRef.current !== pathBeingLoaded;
    // Only blank the editor when switching files. Re-running because collab
    // just synced must keep showing disk content (otherwise the host sees an
    // empty buffer until a full refresh).
    if (pathChanged) {
      setFileReady(false);
      setYText(null);
      setTooLargeBytes(null);
    }
    (async () => {
      try {
        const forceText = forceTextPath === pathBeingLoaded;
        const forceBase64 = forceBase64Path === pathBeingLoaded;
        const atHash = viewingGitHash || deletedSnapshotAt;
        let file;
        try {
          file = await readProjectFile(id, pathBeingLoaded, {
            forceText,
            at: atHash,
            branchId: atHash ? null : branchId,
          });
        } catch (firstErr) {
          // Tip missing but may still exist at the diff baseline.
          if (!atHash && diffOn && diffSince) {
            file = await readProjectFile(id, pathBeingLoaded, {
              forceText,
              at: diffSince,
              branchId,
            });
          } else {
            throw firstErr;
          }
        }
        if (cancelled || activePathRef.current !== pathBeingLoaded) return;
        setError(null);
        if (file.contentOmitted) {
          setYText(null);
          setTooLargeBytes(file.size);
          setBinaryMeta(
            file.text
              ? null
              : {
                  contentType: file.contentType,
                  size: file.size,
                  base64: "",
                },
          );
          setEditMode(file.text ? "text" : "binary");
          setContent("");
          setSavedContent("");
          setFileReady(true);
          setStatus("idle");
          return;
        }
        setTooLargeBytes(null);
        if (forceBase64 || (!file.text && !forceText)) {
          lastTextPathRef.current = pathBeingLoaded;
          if (forceBase64) {
            setEditMode("base64");
            setBinaryMeta(null);
            setContent(file.encoding === "base64" ? file.content : btoa(unescape(encodeURIComponent(file.content))));
            setSavedContent(
              file.encoding === "base64" ? file.content : btoa(unescape(encodeURIComponent(file.content))),
            );
          } else {
            setEditMode("binary");
            setBinaryMeta({
              contentType: file.contentType,
              size: file.size,
              base64: file.content,
            });
            setContent("");
            setSavedContent("");
          }
          setYText(null);
          setFileReady(true);
          setStatus("idle");
          return;
        }

        setBinaryMeta(null);
        setEditMode("text");
        setContent(file.content);
        setSavedContent(file.content);
        setFlushedContent(file.content);
        setLiveContent(file.content);
        lastTextPathRef.current = pathBeingLoaded;

        // Historical leaf or deleted-since-snapshot: snapshot blob only — no tip CRDT.
        if (viewingGitHash || deletedSnapshotAt) {
          setYText(null);
          setFileReady(true);
          setStatus("idle");
          return;
        }

        // Prefer live collab when the room has synced. Never block forever on sync —
        // a large/stale ydoc can leave synced=false indefinitely (Save stuck on Loading…).
        // Keep disk content visible meanwhile.
        if (collab.doc && !collab.synced) {
          setYText(null);
          setFileReady(true);
          setStatus("idle");
          return;
        }

        if (collab.doc && collab.synced) {
          const text = await collab.ensureFile(pathBeingLoaded);
          if (cancelled || activePathRef.current !== pathBeingLoaded) return;
          if (text) {
            const body = text.toString();
            setYText(text);
            setContent(body);
            setSavedContent(body);
            setFlushedContent(body);
            setLiveContent(body);
            setFileReady(true);
            setStatus("ok");
            return;
          }
        }

        // Disk / pre-sync fallback: editable immediately; upgrades to Y.Text when synced flips
        setYText(null);
        setFileReady(true);
        setStatus("idle");
      } catch (err) {
        if (!cancelled && activePathRef.current === pathBeingLoaded) {
          setError(err instanceof Error ? err.message : "Failed to read file");
          setFileReady(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    id,
    activePath,
    forceTextPath,
    forceBase64Path,
    viewingGitHash,
    deletedSnapshotAt,
    diffOn,
    diffSince,
    branchId,
    collab.doc,
    collab.synced,
    collab.ensureFile,
  ]);

  useEffect(() => {
    if (!treeDragging || treeCollapsed) return;
    const onMove = (e: PointerEvent) => {
      const el = workspaceRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const w = Math.min(420, Math.max(160, e.clientX - rect.left));
      setTreeWidth(w);
    };
    const onUp = () => {
      setTreeDragging(false);
      localStorage.setItem("openleaf.treeWidth", String(treeWidthRef.current));
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
  }, [treeDragging, treeCollapsed]);

  const toggleTreeCollapsed = useCallback(() => {
    setTreeCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("openleaf.treeCollapsed", next ? "1" : "0");
      return next;
    });
  }, []);

  const runCompile = useCallback(async (opts?: { auto?: boolean }) => {
    if (!id || !canCompile) return false;
    const epoch = previewEpochRef.current;
    const startedOn = branchIdRef.current;
    const startedAt = viewingGitHashRef.current;
    const stillHere = () =>
      previewEpochRef.current === epoch &&
      branchIdRef.current === startedOn &&
      viewingGitHashRef.current === startedAt;

    while (compileLock.current) {
      await new Promise((r) => window.setTimeout(r, 50));
      if (!stillHere()) return false;
    }
    if (!stillHere()) return false;
    compileLock.current = true;
    setStatus("compiling");
    const checkpointLabel = startedAt
      ? `checkpoint ${startedAt.slice(0, 7)}`
      : branchLabel;
    if (!opts?.auto) {
      setLog("");
      setLogOpen(true);
    } else {
      setLog((prev) =>
        prev
          ? `${prev}\n\n[openleaf] Building PDF for “${checkpointLabel}”…\n`
          : `[openleaf] Building PDF for “${checkpointLabel}”…\n`,
      );
    }
    try {
      const result = await compileProject(
        id,
        {
          onLog: (chunk) => {
            if (!stillHere()) return;
            setLog((prev) => prev + chunk);
          },
        },
        startedAt ? { at: startedAt } : { branchId: startedOn },
      );
      if (!stillHere()) return false;
      setLog((prev) => prev || result.log);
      if (result.ok) {
        setStatus("ok");
        setPdfBust(Date.now());
        setPdfSwitching(false);
        await refreshTree();
        return true;
      }
      setStatus("err");
      setPdfSwitching(false);
      if (opts?.auto) setLogOpen(true);
      return false;
    } catch (err) {
      if (!stillHere()) return false;
      setStatus("err");
      setPdfSwitching(false);
      setLog((prev) => `${prev}\n${err instanceof Error ? err.message : "Compile failed"}`);
      if (opts?.auto) setLogOpen(true);
      return false;
    } finally {
      compileLock.current = false;
    }
  }, [id, refreshTree, canCompile, branchLabel]);

  const runCompileRef = useRef(runCompile);
  runCompileRef.current = runCompile;

  // Each tip (and each historical checkpoint) has its own build artifacts.
  // Live tips always rebuild so uncommitted (and just-flushed CRDT) edits show up.
  // Checkpoints are immutable — reuse a snapshot PDF if one already exists.
  useEffect(() => {
    if (!id || project?.id !== id) return;
    setPdfBust(null);
    if (!canCompile) {
      setPdfSwitching(false);
      return;
    }

    let cancelled = false;
    const ac = new AbortController();
    const epoch = previewEpochRef.current;
    const branchAtStart = branchId;
    const atAtStart = viewingGitHash;
    const still = () =>
      !cancelled &&
      previewEpochRef.current === epoch &&
      branchIdRef.current === branchAtStart &&
      viewingGitHashRef.current === atAtStart;

    (async () => {
      try {
        if (atAtStart) {
          const probe = await fetch(pdfUrl(id, Date.now(), branchAtStart, atAtStart), {
            method: "GET",
            signal: ac.signal,
            cache: "no-store",
          });
          if (!still()) return;
          if (probe.ok) {
            setPdfBust(Date.now());
            setPdfSwitching(false);
            return;
          }
        }
        if (!still()) return;
        await runCompileRef.current({ auto: true });
      } catch {
        if (ac.signal.aborted || !still()) return;
        await runCompileRef.current({ auto: true });
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [id, project?.id, branchId, viewingGitHash, canCompile, pdfNav]);

  const save = useCallback(
    async (opts?: { compile?: boolean; silent?: boolean }) => {
      if (!id || !activePath || editMode === "binary") return;
      if (!fileReady) return;
      if (tooLargeBytes != null) return;
      if (readOnly) {
        if (!opts?.silent) setError("This share link is read-only.");
        return;
      }
      if (!timelineCanEdit) {
        if (!opts?.silent) setError("This leaf is read-only — return to your editable tip to save.");
        return;
      }
      if (saveLock.current) return;
      saveLock.current = true;

      // Explicit save (toolbar / ⌘S) always compiles when requested — Overleaf-style.
      // Autosave passes compile: false so background flushes stay light.
      const wantCompile = opts?.compile === true && canCompile;
      setStatus("saving");
      if (!opts?.silent) setError(null);

      try {
        if (collabText) {
          await flushCollab(id, {
            identityId: collab.identity?.id,
            message: `Save (${activePath})`,
            branchId,
          });
          // Save only flushes the working copy — commits are intentional.
          const text = yText?.toString() ?? liveContent;
          setFlushedContent(text);
          setSavedContent(text);
          setContent(text);
          setLastSavedAt(Date.now());
          if (activePath.endsWith(".bib")) setCitations(extractCitations(text));
          if (activePath.endsWith(".tex")) {
            setExtraLabels((prev) => {
              const set = new Set([...prev, ...extractLabels(text)]);
              return [...set].sort();
            });
          }
          const shouldCompile =
            wantCompile &&
            (activePath.endsWith(".tex") ||
              activePath.endsWith(".bib") ||
              activePath.endsWith(".cls") ||
              activePath.endsWith(".sty") ||
              activePath.includes("figures/"));
          // Save-triggered compiles stay quiet — don't force the log drawer open.
          if (shouldCompile) await runCompile({ auto: true });
          else setStatus("ok");
          return;
        }

        if (content.length === 0 && savedContent.length > 0 && activePath.endsWith(".tex")) {
          setError("Refusing to save empty .tex over non-empty content.");
          setStatus("err");
          return;
        }
        const encoding = editMode === "base64" ? "base64" : "utf8";
        await writeProjectFile(id, activePath, content, encoding);
        setSavedContent(content);
        setFlushedContent(content);
        setLastSavedAt(Date.now());
        if (activePath.endsWith(".bib") && encoding === "utf8") {
          setCitations(extractCitations(content));
        }
        if (activePath.endsWith(".tex") && encoding === "utf8") {
          setExtraLabels((prev) => {
            const set = new Set([...prev, ...extractLabels(content)]);
            return [...set].sort();
          });
        }
        const shouldCompile =
          wantCompile &&
          encoding === "utf8" &&
          (activePath.endsWith(".tex") ||
            activePath.endsWith(".bib") ||
            activePath.endsWith(".cls") ||
            activePath.endsWith(".sty") ||
            activePath.endsWith(".png") ||
            activePath.includes("figures/"));
        // Save-triggered compiles stay quiet — don't force the log drawer open.
        if (shouldCompile) await runCompile({ auto: true });
        else setStatus("ok");
      } catch (err) {
        setStatus("err");
        const msg = err instanceof Error ? err.message : "Save failed";
        setError(msg);
        if (isGuest) void refreshSession();
      } finally {
        saveLock.current = false;
      }
    },
    [
      id,
      activePath,
      content,
      savedContent,
      liveContent,
      config,
      runCompile,
      canCompile,
      editMode,
      fileReady,
      collabText,
      yText,
      collab.identity?.id,
      branchId,
      readOnly,
      timelineCanEdit,
      isGuest,
      refreshSession,
      tooLargeBytes,
    ],
  );

  useEffect(() => {
    if (!id || project?.id !== id) return;
    let cancelled = false;
    (async () => {
      try {
        const view = await getProjectTimeline(id, guestBranchId ?? undefined);
        if (cancelled) return;
        setBranchId(view.activeBranchId);
        setBranchLabel(view.activeBranch.name);
        setTimelineCanEdit(
          view.canEdit && (!guestBranchId || view.activeBranchId === guestBranchId),
        );
        setViewingGitHash(view.viewingGitHash ?? null);
        if (view.headNode) {
          setLastCommit(view.headNode.gitHash.slice(0, 7));
          setTipGitHash(view.headNode.gitHash);
        }
      } catch {
        /* timeline optional until first open */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, project?.id, guestBranchId]);

  useEffect(() => {
    if (!id || isGuest || project?.id !== id) return;
    let cancelled = false;
    void (async () => {
      try {
        const session = await getProjectMerge(id);
        if (cancelled || !session) return;
        setMergeSession(session);
        setMergeOpen(true);
      } catch {
        /* no merge / host-only */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, isGuest, project?.id]);

  // Autosave always on for editable text/base64 buffers (no compile — keep it light).
  useEffect(() => {
    if (!dirty || readOnly || !timelineCanEdit || !fileReady) return;
    if (status === "saving" || status === "compiling") return;
    const t = window.setTimeout(() => {
      void save({ compile: false, silent: true });
    }, 1500);
    return () => window.clearTimeout(t);
  }, [dirty, liveContent, content, readOnly, timelineCanEdit, fileReady, status, save]);

  // Guest: if the live socket drops, re-check the share session promptly.
  useEffect(() => {
    if (!isGuest) return;
    if (collab.status !== "disconnected") return;
    const t = window.setTimeout(() => void refreshSession(), 1200);
    return () => window.clearTimeout(t);
  }, [isGuest, collab.status, refreshSession]);

  useEffect(() => {
    if (dirty) setStatus((s) => (s === "compiling" || s === "saving" ? s : "dirty"));
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden" && dirty) {
        void save({ compile: false, silent: true });
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [dirty, save]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (toolbarMoreOpen) {
        setToolbarMoreOpen(false);
        return;
      }
      if (commentsOpen) {
        setCommentsOpen(false);
        return;
      }
      if (aiReviewOpen) {
        setAiReviewOpen(false);
        return;
      }
      if (shareOpen) {
        setShareOpen(false);
        return;
      }
      if (aiLinksOpen) {
        setAiLinksOpen(false);
        return;
      }
      if (mergeOpen) {
        setMergeOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toolbarMoreOpen, commentsOpen, aiReviewOpen, shareOpen, aiLinksOpen, mergeOpen]);

  // After collab/file load finishes, re-issue any pending SyncTeX jump for this path
  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (!fileReady || !activePath || !pending) return;
    if (pending.path !== activePath) return;
    pendingJumpRef.current = null;
    setJumpTo({
      path: pending.path,
      line: pending.line,
      column: pending.column,
      nonce: Date.now(),
    });
  }, [fileReady, activePath, yText]);

  const showSyncToast = useCallback((msg: string) => {
    setSyncToast(msg);
    window.setTimeout(() => setSyncToast((cur) => (cur === msg ? null : cur)), 2800);
  }, []);

  const onPickCompareBaseline = useCallback(
    (node: TimelineNode, _branch: TimelineBranch) => {
      const label = shortBaselineLabel(node.message, node.gitHash);
      setDiffOn(true);
      setDiffSince(node.gitHash);
      setDiffBaselineLabel(label);
      if (id) persistDiffHighlight(id, true, node.gitHash, label, trackChangesPreviewOn);
      showSyncToast(`Comparing to ${node.gitHash.slice(0, 7)}`);
    },
    [id, showSyncToast, trackChangesPreviewOn],
  );

  const runTrackChangesPdf = useCallback(
    async (fromHash: string, opts?: { download?: boolean }) => {
      if (!id) return;
      const toHash = viewingGitHash || tipGitHash;
      if (!toHash) {
        const msg = "Commit on the timeline first";
        if (opts?.download) setError(msg);
        else setTrackChangesPreviewError(msg);
        return;
      }
      if (!canCompile) {
        const msg = "Track-changes PDF needs compile permission";
        if (opts?.download) setError(msg);
        else setTrackChangesPreviewError(msg);
        return;
      }
      if (opts?.download && !canDownload) {
        setError("Track-changes PDF needs compile and download permission");
        return;
      }
      if (fromHash === toHash) {
        const msg = "Pick a different baseline — this checkpoint is the compare target";
        if (opts?.download) setError(msg);
        else setTrackChangesPreviewError(msg);
        return;
      }

      if (trackChangesPreviewOn) {
        trackChangesPreviewReqRef.current = `${id}:${fromHash}:${toHash}`;
      }

      setError(null);
      if (!opts?.download) setTrackChangesPreviewError(null);
      trackChangesBusyCount.current += 1;
      setTrackChangesBusy(true);
      if (opts?.download) {
        setLog("");
        setLogOpen(true);
        setLog(
          `[openleaf] Building track-changes PDF ${fromHash.slice(0, 7)} → ${toHash.slice(0, 7)}…\n`,
        );
      } else {
        setLog((prev) =>
          prev
            ? `${prev}\n[openleaf] Building track-changes PDF ${fromHash.slice(0, 7)} → ${toHash.slice(0, 7)}…\n`
            : `[openleaf] Building track-changes PDF ${fromHash.slice(0, 7)} → ${toHash.slice(0, 7)}…\n`,
        );
      }
      try {
        const result = await generateTrackChanges(id, fromHash, toHash, {
          onLog: (chunk) => setLog((prev) => prev + chunk),
        });
        setLog((prev) => prev || result.log);
        if (!result.ok) {
          const msg = "Track-changes PDF did not compile. See the log.";
          setError(msg);
          if (!opts?.download) {
            setTrackChangesPreviewPair(null);
            setTrackChangesPreviewError(msg);
            setLogOpen(true);
          }
          return;
        }
        if (trackChangesPreviewOn || !opts?.download) {
          setTrackChangesPreviewPair({ from: result.from.hash, to: result.to.hash });
          setTrackChangesPreviewBust(Date.now());
          setTrackChangesPreviewError(null);
        }
        if (opts?.download) {
          showSyncToast(
            result.cached
              ? `Downloaded cached ${result.from.shortHash} → ${result.to.shortHash}`
              : `Track-changes PDF ${result.from.shortHash} → ${result.to.shortHash}`,
          );
          const a = document.createElement("a");
          a.href = trackChangesDownloadUrl(id, result.from.hash, result.to.hash);
          a.download = `${id}-changes-${result.from.shortHash}-${result.to.shortHash}.pdf`;
          document.body.appendChild(a);
          a.click();
          a.remove();
        } else {
          if (!result.cached) setLogOpen(true);
          showSyncToast(
            result.cached
              ? `Showing cached ${result.from.shortHash} → ${result.to.shortHash}`
              : `Showing track-changes PDF ${result.from.shortHash} → ${result.to.shortHash}`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Track-changes PDF failed";
        setError(msg);
        if (!opts?.download) {
          setTrackChangesPreviewPair(null);
          setTrackChangesPreviewError(msg);
          setLogOpen(true);
        }
      } finally {
        trackChangesBusyCount.current = Math.max(0, trackChangesBusyCount.current - 1);
        if (trackChangesBusyCount.current === 0) setTrackChangesBusy(false);
      }
    },
    [id, viewingGitHash, tipGitHash, canCompile, canDownload, showSyncToast, trackChangesPreviewOn],
  );

  const beginTrackChangesDownload = useCallback(() => {
    setToolbarMoreOpen(false);
    if (!diffSince) {
      pendingTrackChangesRef.current = true;
      setComparePickerOpen(true);
      showSyncToast("Pick a baseline leaf to compare against");
      return;
    }
    void runTrackChangesPdf(diffSince, { download: true });
  }, [diffSince, runTrackChangesPdf, showSyncToast]);

  useEffect(() => {
    if (!id || !diffOn || !trackChangesPreviewOn || !canCompile) return;
    if (!diffSince) return;
    const toHash = viewingGitHash || tipGitHash;
    if (!toHash) {
      setTrackChangesPreviewError("Commit on the timeline first");
      return;
    }
    const reqKey = `${id}:${diffSince}:${toHash}`;
    if (trackChangesPreviewReqRef.current === reqKey) return;
    void runTrackChangesPdf(diffSince);
  }, [
    id,
    diffOn,
    trackChangesPreviewOn,
    diffSince,
    viewingGitHash,
    tipGitHash,
    canCompile,
    runTrackChangesPdf,
  ]);

  const onHighlightSinceCommit = useCallback(
    (commit: GitCommitInfo | string) => {
      const hash = typeof commit === "string" ? commit : commit.hash;
      const message = typeof commit === "string" ? "" : commit.message;
      const label = shortBaselineLabel(message, hash);
      setDiffOn(true);
      setDiffSince(hash);
      setDiffBaselineLabel(label);
      if (id) persistDiffHighlight(id, true, hash, label, trackChangesPreviewOn);
      showSyncToast(`Comparing to ${hash.slice(0, 7)}`);
    },
    [id, showSyncToast, trackChangesPreviewOn],
  );

  const dropPdfPreview = useCallback(() => {
    previewEpochRef.current += 1;
    setPdfBust(null);
    setPdfSwitching(true);
  }, []);

  const beginLeafPreview = useCallback(() => {
    dropPdfPreview();
  }, [dropPdfPreview]);

  const abortLeafPreview = useCallback(() => {
    dropPdfPreview();
    setPdfNav((n) => n + 1);
  }, [dropPdfPreview]);

  const onTimelineChange = useCallback(
    (view: TimelineView) => {
      dropPdfPreview();
      setPdfNav((n) => n + 1);
      setBranchId(view.activeBranchId);
      setBranchLabel(view.activeBranch.name);
      setTimelineCanEdit(
        view.canEdit && (!guestBranchId || view.activeBranchId === guestBranchId),
      );
      setViewingGitHash(view.viewingGitHash ?? null);
      if (view.headNode) {
        setLastCommit(view.headNode.gitHash.slice(0, 7));
        setTipGitHash(view.headNode.gitHash);
      }
      const observing =
        Boolean(guestBranchId) && view.activeBranchId !== guestBranchId;
      showSyncToast(
        observing
          ? `Observing ${view.activeBranch.name} live leaf (read-only)`
          : view.canEdit
            ? `Working on ${view.activeBranch.name}`
            : `Viewing checkpoint ${view.viewingGitHash?.slice(0, 7) ?? ""} (read-only)`,
      );
      // Force file reload for the new tip / snapshot. Clear lastTextPath so the
      // loader treats this as a real navigation even if the path string is unchanged.
      lastTextPathRef.current = null;
      const path = activePathRef.current;
      setContent("");
      setSavedContent("");
      setYText(null);
      setFileReady(false);
      setActivePath(null);
      window.setTimeout(() => {
        if (path) setActivePath(path);
      }, 0);
      void refreshTree();
    },
    [showSyncToast, refreshTree, guestBranchId, dropPdfPreview],
  );

  const onIntentionalCommit = useCallback(async () => {
    if (!id || readOnly || !timelineCanEdit) return;
    const message = window.prompt(`Commit message for branch “${branchLabel}”:`);
    if (!message?.trim()) return;
    setCommitBusy(true);
    setError(null);
    try {
      await flushCollab(id, { identityId: collab.identity?.id, branchId });
      const result = await commitProjectTimeline(id, {
        message: message.trim(),
        branchId,
        identityId: collab.identity?.id,
      });
      setLastCommit(result.hash.slice(0, 7));
      setTipGitHash(result.hash);
      onTimelineChange(result.timeline);
      showSyncToast(`Committed ${result.hash.slice(0, 7)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Commit failed");
    } finally {
      setCommitBusy(false);
    }
  }, [
    id,
    readOnly,
    timelineCanEdit,
    branchLabel,
    branchId,
    collab.identity?.id,
    onTimelineChange,
    showSyncToast,
  ]);

  const normalizeSynctexPath = useCallback(
    (raw: string): string | null => {
      let target = raw.replace(/\\/g, "/").replace(/^\.\//, "");
      if (target.split("/").includes("..") || target.startsWith("/")) {
        const marker = `/${id}/`;
        const idx = `/${target}`.replace(/\/+/g, "/").lastIndexOf(marker);
        if (idx >= 0) {
          target = `/${target}`.replace(/\/+/g, "/").slice(idx + marker.length);
        } else {
          return null;
        }
      }
      if (!target || target.split("/").includes("..")) return null;
      return target;
    },
    [id],
  );

  const jumpToAnchor = useCallback(
    (anchor: CommentAnchor) => {
      const col = Math.max(1, anchor.column || 1);
      const dest = {
        path: anchor.file,
        line: anchor.line,
        column: col,
        nonce: Date.now(),
      };
      pendingJumpRef.current = { path: anchor.file, line: dest.line, column: dest.column };
      setForceTextPath(null);
      setForceBase64Path(null);
      setJumpTo(dest);
      if (window.matchMedia("(max-width: 720px)").matches) setMobilePane("source");
      if (anchor.file !== activePathRef.current) {
        setActivePath(anchor.file);
      }

      // Also scroll/highlight the compiled PDF at the same spot
      void (async () => {
        if (!id) return;
        try {
          if (anchor.pdfPage != null) {
            setPdfHighlight({
              page: anchor.pdfPage,
              x: anchor.pdfX ?? 72,
              y: anchor.pdfY ?? 72,
              width: 120,
              height: 18,
              fullWidth: true,
              label: `${anchor.file}:${anchor.line} → p.${anchor.pdfPage}`,
              nonce: Date.now(),
            });
            return;
          }
          if (!anchor.file.endsWith(".tex") && !anchor.file.endsWith(".ltx")) return;
          const hit = await synctexForward(id, anchor.file, anchor.line, col, branchId, viewingGitHash);
          setPdfHighlight({
            page: hit.page,
            x: hit.x,
            y: hit.y,
            width: hit.width,
            height: hit.height,
            fullWidth: true,
            label: `${anchor.file}:${anchor.line} → p.${hit.page}`,
            nonce: Date.now(),
          });
        } catch {
          /* PDF may be missing or SyncTeX stale — source jump still works */
        }
      })();
    },
    [id, branchId, viewingGitHash],
  );

  const activateReviewHunk = useCallback(
    async (entry: { collab: AiReviewCollaborator; hunk: AiReviewHunk }) => {
      if (!id) return;
      try {
        if (entry.collab.branchId !== branchId) {
          beginLeafPreview();
          const view = await checkoutProjectTimeline(id, { branchId: entry.collab.branchId, nodeId: null });
          onTimelineChange(view);
        }
        setAiActiveId(entry.hunk.id);
        jumpToAnchor(hunkAnchor(entry.hunk));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not open AI suggestion");
      }
    },
    [id, branchId, onTimelineChange, jumpToAnchor, beginLeafPreview],
  );

  useEffect(() => {
    if (!aiFocusNonce || !aiFocusBranchId) return;
    if (aiFocusNonce === consumedAiFocusNonce.current) return;
    const c = aiCollabs.find((x) => x.branchId === aiFocusBranchId);
    if (!c) return;
    const hunk = flattenReviewHunks([c])[0]?.hunk;
    if (!hunk) return;
    consumedAiFocusNonce.current = aiFocusNonce;
    void activateReviewHunk({ collab: c, hunk });
  }, [aiFocusNonce, aiFocusBranchId, aiCollabs, activateReviewHunk]);

  const beginAiReview = useCallback(
    async (opts?: { list?: boolean }) => {
      closeOverlappingChrome("ai");
      if (narrow) {
        setMobilePane("source");
        setAiReviewOpen(Boolean(opts?.list));
      } else {
        setAiReviewOpen(true);
      }
      const all = flattenReviewHunks(aiCollabsRef.current);
      const local = all.filter((x) => x.collab.branchId === branchId);
      const pick = (local.length ? local : all)[0];
      if (!pick) {
        setAiReviewOpen(true);
        return;
      }
      if (opts?.list && narrow) return;
      await activateReviewHunk(pick);
    },
    [narrow, branchId, activateReviewHunk, closeOverlappingChrome],
  );

  const runPopupReview = useCallback(
    async (action: "accept" | "reject") => {
      if (!id || !activeAiHit) return;
      const oldId = activeAiHit.hunk.id;
      const oldList = flattenReviewHunks(aiCollabsRef.current);
      const oldIdx = oldList.findIndex((x) => x.hunk.id === oldId);
      setAiPopupBusy(true);
      try {
        const body = { hunkId: oldId };
        if (action === "accept") await acceptAiReview(id, activeAiHit.collab.aiId, body);
        else await rejectAiReview(id, activeAiHit.collab.aiId, body);
        const data = await listProjectAiReview(id);
        setAiCollabs(data.collaborators);
        setAiReviewCount(data.hunkCount);
        const nextList = flattenReviewHunks(data.collaborators);
        if (nextList.length === 0) {
          setAiActiveId(null);
          return;
        }
        const next = nextList[Math.min(Math.max(0, oldIdx), nextList.length - 1)] ?? nextList[0];
        await activateReviewHunk(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : action === "accept" ? "Could not keep that suggestion" : "Could not dismiss that suggestion");
      } finally {
        setAiPopupBusy(false);
      }
    },
    [id, activeAiHit, activateReviewHunk],
  );

  const onReverseSearch = useCallback(
    async (page: number, x: number, y: number) => {
      if (!id) return;
      try {
        const hit = await synctexLookup(id, page, x, y, branchId, viewingGitHash);
        const target = normalizeSynctexPath(hit.input);
        if (!target) {
          showSyncToast("Stale SyncTeX paths — hit Recompile");
          return;
        }
        const dest = {
          path: target,
          line: hit.line,
          column: Math.max(1, hit.column || 1),
          nonce: Date.now(),
        };
        pendingJumpRef.current = { path: target, line: dest.line, column: dest.column };
        showSyncToast(`→ ${target}:${hit.line}`);
        setForceTextPath(null);
        setForceBase64Path(null);
        setJumpTo(dest);
        if (window.matchMedia("(max-width: 720px)").matches) setMobilePane("source");
        if (target !== activePathRef.current) {
          setActivePath(target);
        }
      } catch {
        showSyncToast("No SyncTeX match — recompile?");
      }
    },
    [id, branchId, viewingGitHash, normalizeSynctexPath, showSyncToast],
  );

  const onPdfComment = useCallback(
    async (page: number, x: number, y: number) => {
      if (!id) return;
      try {
        const hit = await synctexLookup(id, page, x, y, branchId, viewingGitHash);
        const target = normalizeSynctexPath(hit.input);
        if (!target) {
          showSyncToast("Stale SyncTeX paths — hit Recompile");
          return;
        }
        const anchor: CommentAnchor = {
          file: target,
          line: hit.line,
          column: Math.max(1, hit.column || 1),
          pdfPage: page,
          pdfX: x,
          pdfY: y,
        };
        jumpToAnchor(anchor);
        setCommentDraft({ anchor, hint: `PDF p.${page}` });
        closeOverlappingChrome("comments");
        setCommentsOpen(true);
        showSyncToast(`Comment @ ${target}:${hit.line}`);
      } catch {
        showSyncToast("No SyncTeX match — recompile?");
      }
    },
    [id, branchId, viewingGitHash, jumpToAnchor, normalizeSynctexPath, showSyncToast, closeOverlappingChrome],
  );

  const onRequestComment = useCallback(
    (sel: { line: number; column: number; endLine: number; endColumn: number; quote: string }) => {
      if (!activePathRef.current) return;
      const anchor: CommentAnchor = {
        file: activePathRef.current,
        line: sel.line,
        column: sel.column,
        endLine: sel.endLine,
        endColumn: sel.endColumn,
        quote: sel.quote || undefined,
      };
      setCommentDraft({ anchor, hint: sel.quote || undefined });
      closeOverlappingChrome("comments");
      setCommentsOpen(true);
    },
    [closeOverlappingChrome],
  );

  const commentMarks = useMemo(() => {
    if (!activePath) return [];
    return commentThreads
      .filter((t) => t.anchor.file === activePath)
      .map((t) => ({
        line: t.anchor.line,
        color: t.authorColor,
        resolved: t.resolved,
        threadId: t.id,
      }));
  }, [commentThreads, activePath]);

  const openCommentCount = useMemo(
    () => commentThreads.filter((t) => !t.resolved).length,
    [commentThreads],
  );

  const onForwardSearch = useCallback(
    async (line: number, column: number) => {
      if (!id || !activePath) return;
      if (!activePath.endsWith(".tex") && !activePath.endsWith(".ltx")) return;
      try {
        const hit = await synctexForward(id, activePath, line, column, branchId, viewingGitHash);
        setPdfHighlight({
          page: hit.page,
          x: hit.x,
          y: hit.y,
          width: hit.width,
          height: hit.height,
          fullWidth: true,
          label: `${activePath}:${line} → p.${hit.page}`,
          nonce: Date.now(),
        });
        showSyncToast(`→ PDF page ${hit.page}`);
      } catch {
        showSyncToast("No SyncTeX match — recompile?");
      }
    },
    [id, activePath, branchId, viewingGitHash, showSyncToast],
  );

  const openPath = useCallback((path: string) => {
    setForceTextPath(null);
    setForceBase64Path(null);
    setActivePath(path);
    if (window.matchMedia("(max-width: 720px)").matches) setMobilePane("source");
  }, []);

  const onNewFile = async (dir?: string) => {
    if (!id) return;
    const startDir = dir ?? parentDir(activePath);
    const name = window.prompt("New file path (relative to project root)", joinPath(startDir, "untitled.tex"));
    if (!name) return;
    try {
      await createProjectFile(id, name, "");
      await refreshTree();
      openPath(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create file");
    }
  };

  const onNewFolder = async (dir?: string) => {
    if (!id) return;
    const startDir = dir ?? parentDir(activePath);
    const name = window.prompt("New folder path", joinPath(startDir, "sections"));
    if (!name) return;
    try {
      await mkdirProjectPath(id, name);
      await refreshTree();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create folder");
    }
  };

  const onUpload = async (files: FileList, dir?: string) => {
    if (!id) return;
    const targetDir = dir ?? parentDir(activePath);
    try {
      for (const file of Array.from(files)) {
        const dest = joinPath(targetDir || "figures", file.name);
        const b64 = await fileToBase64(file);
        await writeProjectFile(id, dest, b64, "base64");
      }
      await refreshTree();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  };

  const onDelete = async (path?: string) => {
    if (!id) return;
    const target = path ?? activePath;
    if (!target) return;
    if (!window.confirm(`Delete ${target}?`)) return;
    try {
      await deleteProjectPath(id, target);
      if (activePath && (activePath === target || activePath.startsWith(`${target}/`))) {
        setActivePath(project?.mainFile ?? null);
        setForceTextPath(null);
      }
      await refreshTree();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const remapActivePath = (from: string, to: string) => {
    const current = activePathRef.current;
    if (!current) return;
    if (current === from) {
      setActivePath(to);
      setForceTextPath(null);
    } else if (current.startsWith(`${from}/`)) {
      setActivePath(to + current.slice(from.length));
      setForceTextPath(null);
    }
  };

  const onRename = async (path?: string) => {
    if (!id) return;
    const target = path ?? activePath;
    if (!target) return;
    const next = window.prompt("Rename / move to", target);
    if (!next || next === target) return;
    try {
      await renameProjectPath(id, target, next);
      remapActivePath(target, next);
      await refreshTree();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rename failed");
    }
  };

  const onMove = async (from: string, toDir: string) => {
    if (!id) return;
    const base = from.split("/").pop();
    if (!base) return;
    const to = toDir ? `${toDir}/${base}` : base;
    if (to === from) return;
    try {
      await renameProjectPath(id, from, to);
      remapActivePath(from, to);
      await refreshTree();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Move failed");
    }
  };

  const onReplaceBinary = async (file: File) => {
    if (!id || !activePath) return;
    try {
      const b64 = await fileToBase64(file);
      await writeProjectFile(id, activePath, b64, "base64");
      setForceTextPath(null);
      const reloaded = await readProjectFile(id, activePath);
      if (reloaded.text) {
        setEditMode("text");
        setContent(reloaded.content);
        setSavedContent(reloaded.content);
        setBinaryMeta(null);
      } else {
        setEditMode("binary");
        setBinaryMeta({
          contentType: reloaded.contentType,
          size: reloaded.size,
          base64: reloaded.content,
        });
      }
      setStatus("ok");
      if (config?.latex.autoCompile !== false) await runCompile();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Replace failed");
    }
  };

  const statusLabel = useMemo(() => {
    if (status === "saving") return "Saving…";
    if (status === "compiling") return "Compiling…";
    if (status === "err") return "Error";
    if (status === "dirty") return "Unsaved changes";
    if (collabText && status === "idle") {
      if (collab.status === "connecting") return "Connecting…";
      if (collab.status === "connected" && !collab.synced) return "Syncing…";
    }
    if (lastSavedAt) return `Saved ${formatLastSaved(lastSavedAt)}`;
    if (collabText && collab.status === "connected" && collab.synced) return "Live";
    if (status === "ok") return collabText ? "Live" : "Up to date";
    return collab.synced ? "Live" : "Ready";
  }, [status, collabText, collab.status, collab.synced, lastSavedAt]);

  // Unique peers by awareness client (two people can share a name in different sessions)
  const presence = useMemo(() => {
    return collab.peers.map((p) => ({
      clientId: p.clientId,
      id: p.user.id,
      name: p.user.name,
      color: p.user.color,
    }));
  }, [collab.peers]);

  if (!project || project.id !== id) {
    if (error) {
      return (
        <div className="home">
          <div className="error-banner">{error}</div>
          <Link to="/">← Back</Link>
        </div>
      );
    }
    return <div className="guest-shell guest-loading">Opening project…</div>;
  }

  const markupPreviewActive = Boolean(diffOn && trackChangesPreviewOn && canCompile);
  const pdfViewerUrl = pdfSwitching
    ? null
    : markupPreviewActive && trackChangesPreviewPair
      ? trackChangesPdfUrl(
          id,
          trackChangesPreviewPair.from,
          trackChangesPreviewPair.to,
          trackChangesPreviewBust ?? undefined,
        )
      : !markupPreviewActive && pdfBust != null
        ? pdfUrl(id, pdfBust, branchId, viewingGitHash)
        : null;
  const pdfEmptyHint =
    pdfSwitching && status !== "compiling" && status !== "err"
      ? "Opening that leaf…"
      : markupPreviewActive
    ? trackChangesBusy
      ? "Building latexdiff track-changes PDF of the compare baseline vs this checkpoint…"
      : trackChangesPreviewError
        ? trackChangesPreviewError
        : !diffSince
          ? "Pick a compare baseline to build the track-changes PDF."
          : !(viewingGitHash || tipGitHash)
            ? "Commit on the timeline first to build a track-changes PDF."
            : "Preparing track-changes PDF…"
    : viewingGitHash
      ? status === "compiling"
        ? `Building PDF for checkpoint ${viewingGitHash.slice(0, 7)}…`
        : status === "err"
          ? "PDF build failed for this checkpoint — check the log or click Recompile."
          : canCompile
            ? `Preparing PDF for checkpoint ${viewingGitHash.slice(0, 7)}…`
            : "No PDF for this checkpoint yet (compile disabled)."
      : status === "compiling"
        ? `Building PDF for “${branchLabel}”…`
        : status === "err"
          ? "PDF build failed — check the log or click Recompile."
          : canCompile
            ? `Preparing PDF for “${branchLabel}”…`
            : "No PDF on this link yet (compile disabled).";

  return (
    <div className={`editor-page${narrow ? " is-narrow" : ""}`}>
      <div className="editor-toolbar">
        <div className="toolbar-cluster">
          <img className="toolbar-logo" src="/logo.png" alt="OpenLeaf logo" />
          {isGuest ? (
            <span className="badge share-guest-badge" title="You joined through a share link">
              Shared with you
            </span>
          ) : (
            <Link className="btn btn-ghost btn-quiet" to="/" title="Back to projects">
              Projects
            </Link>
          )}
          <span className="toolbar-project-name" title={project?.id ?? id}>
            {project?.id ?? id}
          </span>
          <div className="toolbar-meta toolbar-wide-only">
            <span
              className={`status-pill ${
                status === "saving" || status === "compiling"
                  ? "saving"
                  : status === "dirty"
                    ? "dirty"
                    : status === "ok" || (lastSavedAt && status !== "err")
                      ? "ok"
                      : status
              }`}
              title={
                lastSavedAt
                  ? `Saved ${formatLastSaved(lastSavedAt)} · autosave is on; Commit creates a timeline checkpoint`
                  : "Autosave is on — edits flush to disk shortly. Commit creates a timeline checkpoint."
              }
            >
              {statusLabel}
            </span>
            {editMode === "base64" && <span className="status-pill warn">base64</span>}
            {readOnly && <span className="status-pill warn">read-only</span>}
          </div>
        </div>

        <div className="toolbar-cluster toolbar-collab toolbar-wide-only">
          <div
            className="presence-strip"
            title={
              presence.length <= 1
                ? "Only you are editing right now"
                : `${presence.length} editors connected`
            }
          >
            {presence.length <= 1 ? (
              <span className="presence-solo" aria-live="polite">
                Just you
              </span>
            ) : (
              presence.map((p) => (
                <span
                  key={p.clientId}
                  className={`presence-chip${collab.identity?.id === p.id ? " me" : ""}`}
                  style={{ ["--presence" as string]: p.color }}
                >
                  {p.name}
                </span>
              ))
            )}
          </div>

          {isGuest && guest ? (
            <span className="identity-picker guest-you-chip" title="Signed in as a guest">
              <span className="identity-picker-label">Guest</span>
              <span className="presence-chip me" style={{ ["--presence" as string]: guest.guest.color }}>
                {guest.guest.name}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-quiet"
                onClick={() => {
                  void guestLogout().finally(() => void refreshSession());
                }}
                title="Leave this session"
              >
                Leave
              </button>
            </span>
          ) : collab.identities.length > 0 ? (
            <label className="identity-picker">
              <span className="identity-picker-label">You</span>
              <select
                value={collab.identity?.id ?? ""}
                onChange={(e) => collab.setIdentityId(e.target.value)}
                aria-label="Select identity"
              >
                {collab.identities.map((ident) => (
                  <option key={ident.id} value={ident.id}>
                    {ident.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="status-pill warn" title="Add identities in this project's openleaf.json">
              No identities configured
            </span>
          )}
        </div>

        <div className="toolbar-actions">
          {!isGuest && shareActive && (
            <button
              type="button"
              className={`btn share-timer-chip${shareUrgent ? " is-urgent" : ""}`}
              onClick={() => {
                closeOverlappingChrome("share");
                setShareOpen(true);
              }}
              title={
                shareCount > 1
                  ? `${shareCount} live user links — click to manage`
                  : shareExpiresAt === null
                    ? "Session has no automatic expiry — click to manage"
                    : shareExpiresAt
                      ? `Session ends ${new Date(shareExpiresAt).toLocaleString()} — click to extend`
                      : "Live share session — click to manage"
              }
            >
              <span className="share-timer-dot" aria-hidden>
                ●
              </span>
              {shareCount > 1 ? `Live · ${shareCount}` : shareTimerLabel}
            </button>
          )}
          {canHistory && (
            <button
              type="button"
              className={`btn btn-quiet${historyOpen ? " is-active" : ""}`}
              onClick={() => {
                closeOverlappingChrome("history");
                setHistoryOpen(true);
              }}
              title={lastCommit ? `${branchLabel}@${lastCommit}` : branchLabel}
            >
              Timeline
            </button>
          )}
          {!isGuest && mergeSession && (
            <button
              type="button"
              className="btn btn-primary toolbar-merge-btn"
              onClick={() => {
                closeOverlappingChrome();
                setMergeOpen(true);
              }}
              title="Merge in progress — Hide only closes the panel; Abort cancels the merge"
            >
              {mergeSession.conflicts.some((c) => !c.resolved)
                ? `Merge · ${mergeSession.conflicts.filter((c) => !c.resolved).length} left`
                : "Merge · ready"}
            </button>
          )}
          {!readOnly && timelineCanEdit && !mergeSession && (
            <button
              type="button"
              className={dirty ? "btn btn-primary" : "btn btn-quiet"}
              disabled={commitBusy || status === "saving"}
              onClick={() => void onIntentionalCommit()}
              title={
                lastCommit
                  ? `Checkpoint on ${branchLabel} (tip ${lastCommit}). Autosave does not commit.`
                  : `Create a timeline checkpoint on ${branchLabel}. Autosave does not commit.`
              }
            >
              {commitBusy ? "Committing…" : "Commit"}
            </button>
          )}
          {!timelineCanEdit && !isGuest && (
            <span className="share-muted" title="Historical checkpoint">
              Read-only checkpoint
            </span>
          )}
          {!timelineCanEdit && isGuest && (
            <span className="share-muted" title="You are watching another branch’s live working copy">
              Observing {branchLabel}
            </span>
          )}
          {!readOnly && timelineCanEdit && (
            <button
              type="button"
              className={
                dirty || status === "saving" || status === "compiling"
                  ? "btn btn-primary"
                  : "btn btn-quiet"
              }
              onClick={() => void save({ compile: true })}
              disabled={
                !activePath ||
                !fileReady ||
                editMode === "binary" ||
                tooLargeBytes != null ||
                status === "saving" ||
                status === "compiling"
              }
              title={
                canCompile
                  ? "Save and recompile (⌘S / Ctrl+S). Autosave still runs in the background without compiling."
                  : "Save now (⌘S / Ctrl+S). Autosave is already on."
              }
            >
              {status === "compiling"
                ? "Compiling…"
                : status === "saving"
                  ? "Saving…"
                  : canCompile
                    ? "Recompile"
                    : collabText
                      ? "Save & sync"
                      : "Save"}
            </button>
          )}
          {(readOnly || Boolean(viewingGitHash)) && canCompile && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void runCompile()}
              disabled={status === "compiling"}
              title={
                viewingGitHash
                  ? `Recompile checkpoint ${viewingGitHash.slice(0, 7)}`
                  : "Recompile the current project"
              }
            >
              {status === "compiling" ? "Compiling…" : "Recompile"}
            </button>
          )}

          {openCommentCount > 0 && (
            <button
              type="button"
              className={`btn btn-quiet toolbar-comments has-open${commentsOpen ? " is-active" : ""}`}
              onClick={() => {
                closeOverlappingChrome("comments");
                setCommentsOpen(true);
              }}
              title="Open comments"
            >
              Comments
              <span className="toolbar-comments-badge">{openCommentCount}</span>
            </button>
          )}

          {!isGuest && aiReviewCount > 0 && (
            <button
              type="button"
              className={`btn btn-quiet toolbar-comments toolbar-ai-review has-open${aiReviewOpen || (narrow && aiActiveId) ? " is-active" : ""}`}
              onClick={() => {
                void beginAiReview();
              }}
              title="Review AI wording in the manuscript — Accept keeps it, Dismiss restores it"
            >
              AI
              <span className="toolbar-comments-badge">{aiReviewCount}</span>
            </button>
          )}

          <div className="toolbar-more" ref={toolbarMoreRef}>
            <button
              ref={toolbarMoreBtnRef}
              type="button"
              className="btn btn-ghost btn-icon toolbar-download-btn"
              aria-expanded={toolbarMoreOpen}
              aria-haspopup="menu"
              title="More actions"
              aria-label="More actions"
              onClick={() => setToolbarMoreOpen((v) => !v)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none" />
                <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
                <circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none" />
              </svg>
            </button>
            {toolbarMoreOpen &&
              toolbarMenuBox &&
              createPortal(
              <div
                ref={toolbarMenuRef}
                className="toolbar-menu is-floating"
                role="menu"
                style={{
                  top: toolbarMenuBox.top,
                  right: toolbarMenuBox.right,
                  maxHeight: toolbarMenuBox.maxHeight,
                }}
              >
                {narrow && isGuest && guest && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setToolbarMoreOpen(false);
                      void guestLogout().finally(() => void refreshSession());
                    }}
                  >
                    Leave session
                    <span className="toolbar-menu-hint">{guest.guest.name}</span>
                  </button>
                )}
                {narrow && !isGuest && collab.identities.length > 0 && (
                  <label className="identity-picker toolbar-menu-identity">
                    <span className="identity-picker-label">You</span>
                    <select
                      value={collab.identity?.id ?? ""}
                      onChange={(e) => collab.setIdentityId(e.target.value)}
                      aria-label="Select identity"
                    >
                      {collab.identities.map((ident) => (
                        <option key={ident.id} value={ident.id}>
                          {ident.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {narrow && (!isGuest || !readOnly) && timelineCanEdit && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setToolbarMoreOpen(false);
                      window.dispatchEvent(new CustomEvent("openleaf:request-comment"));
                    }}
                  >
                    Comment on selection
                  </button>
                )}
                {narrow && (isGuest || collab.identities.length > 0) && <div className="toolbar-menu-sep" />}
                {!isGuest && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setToolbarMoreOpen(false);
                      closeOverlappingChrome("share");
                      setShareOpen(true);
                    }}
                  >
                    Share
                    {shareActive ? <span className="toolbar-menu-hint">Live</span> : null}
                  </button>
                )}
                {(!isGuest || !readOnly) && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setToolbarMoreOpen(false);
                      closeOverlappingChrome("aiLinks");
                      setAiLinksOpen(true);
                    }}
                  >
                    AI links
                    {aiLinkCount > 0 ? <span className="toolbar-menu-hint">{aiLinkCount}</span> : null}
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setToolbarMoreOpen(false);
                    closeOverlappingChrome("comments");
                    setCommentsOpen(true);
                  }}
                >
                  Comments
                  {openCommentCount > 0 ? <span className="toolbar-menu-hint">{openCommentCount}</span> : null}
                </button>
                {!isGuest && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setToolbarMoreOpen(false);
                      void beginAiReview();
                    }}
                  >
                    AI suggestions
                    {aiReviewCount > 0 ? <span className="toolbar-menu-hint">{aiReviewCount}</span> : null}
                  </button>
                )}
                {narrow && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setToolbarMoreOpen(false);
                      setLogOpen(true);
                    }}
                  >
                    Compile log
                  </button>
                )}
                <div className="toolbar-menu-sep" />
                <div className="toolbar-menu-theme" onMouseDown={(e) => e.stopPropagation()}>
                  <ThemePicker compact />
                </div>
                {isRemoteHost && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setToolbarMoreOpen(false);
                      void hostLogout().finally(() => void refreshSession());
                    }}
                  >
                    Sign out
                  </button>
                )}
                {canDownload && (
                  <>
                    <div className="toolbar-menu-sep" />
                    <a
                      role="menuitem"
                      href={downloadUrl(id, "pdf", branchId, viewingGitHash)}
                      download={`${id}.pdf`}
                      onClick={() => setToolbarMoreOpen(false)}
                    >
                      <span>Download PDF</span>
                    </a>
                    <a
                      role="menuitem"
                      href={downloadUrl(id, "zip", branchId)}
                      download={`${id}.zip`}
                      onClick={() => setToolbarMoreOpen(false)}
                    >
                      <span>Download ZIP</span>
                    </a>
                    {canCompile && (
                      <button
                        type="button"
                        role="menuitem"
                        disabled={trackChangesBusy}
                        title="Compare-documents PDF of the compare baseline vs this checkpoint. Uncommitted edits are not included."
                        onClick={() => beginTrackChangesDownload()}
                      >
                        {trackChangesBusy ? "Building track-changes PDF…" : "Download track-changes PDF"}
                      </button>
                    )}
                  </>
                )}
              </div>,
              document.body,
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="error-banner" style={{ margin: 0, borderRadius: 0 }}>
          {error}
          <button type="button" className="btn btn-ghost" style={{ marginLeft: "0.75rem" }} onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {syncToast && <div className="sync-toast">{syncToast}</div>}

      {!isGuest && (
        <SharePanel
          projectId={id}
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          onActiveChange={onShareStatus}
          onTimelineChange={onTimelineChange}
        />
      )}

      {(!isGuest || !readOnly) && (
        <AiLinkPanel
          projectId={id}
          open={aiLinksOpen}
          onClose={() => setAiLinksOpen(false)}
          branchId={branchId}
          branchName={branchLabel}
          guestBoundBranchId={guestBranchId}
          guestBoundBranchName={guest?.share.branchName ?? null}
          guestId={guest?.guest.id ?? null}
          canEditLeaf={timelineCanEdit && !readOnly}
          onTimelineChange={onTimelineChange}
          onCountChange={setAiLinkCount}
          onOpenAiReview={() => void beginAiReview()}
        />
      )}

      <BranchTreePanel
        projectId={id}
        identityId={collab.identity?.id}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        canFork={!isGuest}
        canCheckout={!isGuest}
        canMerge={!isGuest}
        canPrune={!isGuest}
        guestBranchId={guestBranchId}
        leavesVersion={collab.leavesVersion}
        onHighlightSince={config?.git?.enabled === false ? undefined : (hash) => onHighlightSinceCommit(hash)}
        onNavigateStart={beginLeafPreview}
        onNavigateAbort={abortLeafPreview}
        onOpenNode={(node, branch) => {
          if (branch.headNodeId !== node.id) return;
          reopenAiLeafNotifications(branch);
        }}
        onMergeStarted={(session) => {
          setMergeSession(session);
          setMergeOpen(true);
          showSyncToast(
            session.conflicts.length
              ? `Merge started — ${session.conflicts.length} conflict${session.conflicts.length === 1 ? "" : "s"} to review`
              : "Merge started — no conflicts, ready to complete",
          );
        }}
        onBeforeMerge={async (flushBranchId) => {
          await flushCollab(id, { identityId: collab.identity?.id, branchId: flushBranchId ?? branchId });
        }}
        onTimelineChange={(view) => {
          // Keep timeline open so hosts can click through leaves without reopening it.
          onTimelineChange(view);
        }}
      />

      {!isGuest && (
        <MergePanel
          projectId={id}
          open={mergeOpen}
          onSessionChange={setMergeSession}
          onClose={() => setMergeOpen(false)}
          onFinished={(view) => {
            setMergeSession(null);
            setMergeOpen(false);
            onTimelineChange(view);
            showSyncToast(`Working on ${view.activeBranch.name}`);
          }}
        />
      )}

      <CommentsPanel
        projectId={id}
        identityId={collab.identity?.id}
        open={commentsOpen}
        onClose={() => setCommentsOpen(false)}
        commentsVersion={collab.commentsVersion}
        draft={commentDraft}
        onDraftConsumed={() => setCommentDraft(null)}
        onJump={jumpToAnchor}
        onThreadsChange={setCommentThreads}
        focusThreadId={focusCommentId}
        canDeleteThread={isGuest ? (t) => t.authorId === guest?.guest.id : undefined}
      />

      {!isGuest && (
        <AiReviewPanel
          projectId={id}
          open={aiReviewOpen}
          onClose={() => setAiReviewOpen(false)}
          currentBranchId={branchId}
          reviewVersion={collab.aiReviewVersion}
          activeHunkId={aiActiveId}
          onActiveHunkIdChange={setAiActiveId}
          onCollaboratorsChange={onAiCollabsChange}
          onCountChange={setAiReviewCount}
          onTimelineChange={onTimelineChange}
          onJump={(path, line, column) => jumpToAnchor({ file: path, line, column: column ?? 1 })}
          onPickedHunk={narrow ? () => setAiReviewOpen(false) : undefined}
          variant={narrow ? "sheet" : "drawer"}
          focusBranchId={aiFocusBranchId}
          focusNonce={aiFocusNonce}
        />
      )}

      <div
        className={`workspace${narrow ? " is-narrow" : ""}`}
        data-mobile-pane={narrow ? mobilePane : undefined}
        ref={workspaceRef}
      >
        <div className="split-row workspace-split" style={{ flex: 1, minHeight: 0 }}>
          <div
            className={`pane pane-tree${treeCollapsed && !narrow ? " is-collapsed" : ""}`}
            style={{ flex: `0 0 ${narrow ? "100%" : treeCollapsed ? "40px" : `${treeWidth}px`}` }}
          >
            <div className="pane-title pane-title-row">
              {(!treeCollapsed || narrow) && <span>Files</span>}
              <button
                type="button"
                className="btn btn-ghost btn-icon tree-collapse-btn toolbar-wide-only"
                onClick={toggleTreeCollapsed}
                title={treeCollapsed ? "Show file explorer" : "Hide file explorer"}
                aria-label={treeCollapsed ? "Show file explorer" : "Hide file explorer"}
                aria-expanded={!treeCollapsed}
              >
                {treeCollapsed ? (
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
            {(!treeCollapsed || narrow) && (
              <FileTree
                nodes={tree}
                activePath={activePath}
                onOpen={openPath}
                onNewFile={(dir) => void onNewFile(dir)}
                onNewFolder={(dir) => void onNewFolder(dir)}
                onUpload={(files, dir) => void onUpload(files, dir)}
                onDelete={(path) => void onDelete(path)}
                onRename={(path) => void onRename(path)}
                onMove={(from, toDir) => {
                  if (!readOnly) void onMove(from, toDir);
                }}
                canMutateActive={Boolean(activePath)}
                readOnly={readOnly || !timelineCanEdit}
                fileChanges={fileChangeMap}
              />
            )}
          </div>
          {(!treeCollapsed || narrow) && (
            <div
              className={`split-handle workspace-tree-handle${treeDragging ? " active" : ""}`}
              onPointerDown={() => setTreeDragging(true)}
              role="separator"
              aria-orientation="vertical"
            />
          )}
          <div className="pane pane-main" style={{ flex: 1, minWidth: 0 }}>
            <SplitPane
              className="split-editor"
              storageKey={`openleaf.split.${id}`}
              initialLeftRatio={0.52}
              left={
                <div className="pane editor-pane" style={{ height: "100%" }}>
                  {tooLargeBytes != null ? (
                    <div className="empty-hint" style={{ padding: "1.25rem" }}>
                      <strong>{activePath}</strong>
                      <p style={{ marginTop: "0.75rem" }}>
                        This file is {formatBytes(tooLargeBytes)} — too large to open in the
                        browser editor (limit 1.5 MB). Edit it on disk, or replace a binary
                        via upload.
                      </p>
                    </div>
                  ) : editMode === "binary" && activePath && binaryMeta ? (
                    <BinaryPane
                      path={activePath}
                      contentType={binaryMeta.contentType}
                      size={binaryMeta.size}
                      base64={binaryMeta.base64}
                      onReplace={(file) => {
                        if (readOnly) setError("This share link is read-only.");
                        else void onReplaceBinary(file);
                      }}
                      onEditAsText={() => {
                        setForceBase64Path(null);
                        setForceTextPath(activePath);
                      }}
                      onEditAsBase64={() => {
                        setForceTextPath(null);
                        setForceBase64Path(activePath);
                      }}
                    />
                  ) : (
                    <>
                      <div className="pane-title pane-title-row">
                        <span>
                          Source{editMode === "base64" ? " · base64" : ""}
                          {viewingDeletedFile && (
                            <span className="ol-diff-file-pill ol-diff-file-pill--deleted">deleted</span>
                          )}
                          {diffOn && activeChangeHint && !viewingDeletedFile && (
                            <span className="ol-diff-file-pill">
                              <span className="pdf-diff-stat-add">+{activeChangeHint.additions}</span>
                              <span className="pdf-diff-stat-del">−{activeChangeHint.deletions}</span>
                            </span>
                          )}
                        </span>
                        {!readOnly && timelineCanEdit && !viewingDeletedFile && activePath && (
                          <button
                            type="button"
                            className="btn btn-ghost pane-comment-btn toolbar-wide-only"
                            title="Select text in the editor, then click — or press ⌘⌥M / Ctrl+Alt+M"
                            onClick={() => {
                              window.dispatchEvent(new CustomEvent("openleaf:request-comment"));
                            }}
                          >
                            Comment
                          </button>
                        )}
                      </div>
                      <CodeEditor
                        path={activePath}
                        value={content}
                        onChange={setContent}
                        onSave={() => void save({ compile: true })}
                        jumpTo={jumpTo}
                        citations={citations}
                        labels={labels}
                        onForwardSearch={(line, col) => void onForwardSearch(line, col)}
                        yText={collabText ? yText : null}
                        awareness={collabText ? collab.awareness : null}
                        readOnly={readOnly || !timelineCanEdit || viewingDeletedFile}
                        commentMarks={commentMarks}
                        onRequestComment={onRequestComment}
                        onOpenCommentThread={(threadId) => {
                          setFocusCommentId(threadId);
                          setCommentsOpen(true);
                        }}
                        changeMarks={changeMarks}
                        suggestionMarks={suggestionMarks}
                        activeSuggestionId={aiActiveId}
                        onSelectSuggestion={setAiActiveId}
                        suggestionDock={narrow}
                        suggestionPopup={
                          activeAiHit && activeAiHit.collab.branchId === branchId ? (
                            <AiSuggestionCard
                              key={`${activeAiHit.hunk.id}-${aiFocusNonce}`}
                              hunk={activeAiHit.hunk}
                              compact
                              busy={aiPopupBusy}
                              onAccept={() => void runPopupReview("accept")}
                              onReject={() => void runPopupReview("reject")}
                              nav={
                                narrow && reviewNavIndex >= 0
                                  ? {
                                      index: reviewNavIndex,
                                      total: reviewHunks.length,
                                      onPrev: () => {
                                        const e = reviewHunks[reviewNavIndex - 1];
                                        if (e) void activateReviewHunk(e);
                                      },
                                      onNext: () => {
                                        const e = reviewHunks[reviewNavIndex + 1];
                                        if (e) void activateReviewHunk(e);
                                      },
                                      onList: () => setAiReviewOpen(true),
                                      onClose: () => setAiActiveId(null),
                                    }
                                  : undefined
                              }
                            />
                          ) : null
                        }
                      />
                    </>
                  )}
                </div>
              }
              right={
                <PdfViewer
                  key={`${id}:${branchId}:${viewingGitHash ?? "tip"}`}
                  url={pdfViewerUrl}
                  emptyHint={pdfEmptyHint}
                  onReverseSearch={onReverseSearch}
                  onCommentAt={(page, x, y) => void onPdfComment(page, x, y)}
                  highlight={pdfHighlight}
                  overlays={diffOn && !trackChangesPreviewOn ? diffBoxes : undefined}
                  diffHighlight={
                    config?.git?.enabled === false
                      ? null
                      : {
                          enabled: diffOn,
                          baselineHash: diffSince,
                          baselineLabel: diffBaselineLabel,
                          lineCount: diffLines,
                          fileCount: diffFiles,
                          additions: diffAdditions,
                          deletions: diffDeletions,
                          loading: diffLoading || (markupPreviewActive && trackChangesBusy),
                          warning: trackChangesPreviewError ?? diffWarning,
                          onEnabledChange: onDiffEnabledChange,
                          onPickBaseline: () => setComparePickerOpen(true),
                          markupPdf: {
                            enabled: trackChangesPreviewOn,
                            available: canCompile,
                            loading: trackChangesBusy && trackChangesPreviewOn,
                            onEnabledChange: onTrackChangesPreviewChange,
                          },
                        }
                  }
                />
              }
            />
          </div>
        </div>
        {(!narrow || logOpen || status === "err") && (
          <CompileLog
            className={narrow ? "is-overlay" : undefined}
            log={log}
            open={logOpen}
            onToggle={() => setLogOpen((v) => !v)}
            height={narrow ? 140 : 180}
          />
        )}
        {narrow && (
          <nav className="mobile-pane-switcher" aria-label="Editor views">
            <button
              type="button"
              className={mobilePane === "files" ? "is-active" : ""}
              onClick={() => setMobilePane("files")}
            >
              Files
            </button>
            <button
              type="button"
              className={mobilePane === "source" ? "is-active" : ""}
              onClick={() => setMobilePane("source")}
            >
              Source
            </button>
            <button
              type="button"
              className={mobilePane === "preview" ? "is-active" : ""}
              onClick={() => setMobilePane("preview")}
            >
              Preview
            </button>
          </nav>
        )}
      </div>

      <CompareBaselinePicker
        projectId={id}
        open={comparePickerOpen}
        selectedHash={diffSince || null}
        onClose={() => {
          pendingTrackChangesRef.current = false;
          setComparePickerOpen(false);
        }}
        onPick={(node, branch) => {
          onPickCompareBaseline(node, branch);
          if (pendingTrackChangesRef.current) {
            pendingTrackChangesRef.current = false;
            void runTrackChangesPdf(node.gitHash, { download: true });
          }
        }}
      />
    </div>
  );
}
