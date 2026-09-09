import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type * as Y from "yjs";
import {
  compileProject,
  createProjectFile,
  deleteProjectPath,
  downloadUrl,
  getConfig,
  getDiffHighlights,
  getProject,
  getTree,
  listProjectComments,
  listProjectHistory,
  mkdirProjectPath,
  pdfUrl,
  readProjectFile,
  renameProjectPath,
  synctexForward,
  synctexLookup,
  writeProjectFile,
} from "../api/client";
import type { AppConfig, GitCommitInfo, ProjectMeta, TreeNode } from "../api/types";
import { guestLogout } from "../api/share";
import { flushCollab, useProjectCollab } from "../collab/useProjectCollab";
import { BinaryPane } from "../components/BinaryPane";
import { CodeEditor } from "../components/CodeEditor";
import { CompileLog } from "../components/CompileLog";
import { FileTree } from "../components/FileTree";
import { CommentsPanel, type CommentDraft } from "../components/CommentsPanel";
import { HistoryPanel } from "../components/HistoryPanel";
import { PdfViewer, type PdfDiffOverlay, type PdfHighlight } from "../components/PdfViewer";
import { SharePanel } from "../components/SharePanel";
import { SplitPane } from "../components/SplitPane";
import { ThemeToggle } from "../components/ThemeToggle";
import { extractCitations, extractLabels } from "../latex/completions";
import type { CommentAnchor, CommentThread } from "../api/types";
import { useGuest, useSession } from "../session/SessionContext";

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

function persistDiffHighlight(projectId: string, enabled: boolean, since: string): void {
  localStorage.setItem(diffHighlightKey(projectId), JSON.stringify({ enabled, since: since || null }));
}

function readDiffHighlightPref(projectId: string): { enabled: boolean; since: string } {
  try {
    const raw = localStorage.getItem(diffHighlightKey(projectId));
    if (!raw) return { enabled: false, since: "" };
    const pref = JSON.parse(raw) as { enabled?: boolean; since?: string | null };
    return {
      enabled: Boolean(pref.enabled),
      since: typeof pref.since === "string" ? pref.since : "",
    };
  } catch {
    return { enabled: false, since: "" };
  }
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

export function EditorPage() {
  const { id = "" } = useParams();
  const guest = useGuest();
  const { refresh: refreshSession } = useSession();
  const guestIdentity = useMemo(
    () => (guest ? { id: guest.guest.id, name: guest.guest.name, color: guest.guest.color } : null),
    [guest?.guest.id, guest?.guest.name, guest?.guest.color],
  );
  const isGuest = guest !== null;
  const readOnly = guest?.share.readOnly ?? false;
  const canCompile = !guest || guest.share.allowCompile;
  const canDownload = !guest || guest.share.allowDownload;
  const canHistory = !guest || guest.share.allowHistory;
  const collab = useProjectCollab(id || undefined, guestIdentity);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareActive, setShareActive] = useState(false);
  const [shareExpiresAt, setShareExpiresAt] = useState<number | null | undefined>(undefined);
  const [shareTimerLabel, setShareTimerLabel] = useState("Live link");
  const [shareUrgent, setShareUrgent] = useState(false);
  const shareExpiresAtRef = useRef(shareExpiresAt);
  shareExpiresAtRef.current = shareExpiresAt;

  const onShareStatus = useCallback((info: { active: boolean; expiresAt: number | null | undefined }) => {
    setShareActive(info.active);
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

  const [project, setProject] = useState<ProjectMeta | null>(null);
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
  const [logOpen, setLogOpen] = useState(true);
  const [status, setStatus] = useState<Status>("idle");
  const [pdfBust, setPdfBust] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [citations, setCitations] = useState<string[]>([]);
  const [extraLabels, setExtraLabels] = useState<string[]>([]);
  const [treeWidth, setTreeWidth] = useState(() => {
    const n = Number(localStorage.getItem("openleaf.treeWidth") ?? 240);
    return Number.isFinite(n) ? Math.min(420, Math.max(160, n)) : 240;
  });
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
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [commentThreads, setCommentThreads] = useState<CommentThread[]>([]);
  const [lastCommit, setLastCommit] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [flushedContent, setFlushedContent] = useState("");
  const saveLock = useRef(false);
  const [diffOn, setDiffOn] = useState(false);
  const [diffSince, setDiffSince] = useState("");
  const [diffCommits, setDiffCommits] = useState<GitCommitInfo[]>([]);
  const [diffBoxes, setDiffBoxes] = useState<PdfDiffOverlay[]>([]);
  const [diffLines, setDiffLines] = useState<number | null>(null);
  const [diffFiles, setDiffFiles] = useState<number | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffWarning, setDiffWarning] = useState<string | null>(null);
  const compileLock = useRef(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const [fileReady, setFileReady] = useState(false);
  const [tooLargeBytes, setTooLargeBytes] = useState<number | null>(null);

  const collabText = editMode === "text" && yText != null;
  const dirty =
    !readOnly &&
    editMode !== "binary" &&
    fileReady &&
    (collabText ? liveContent !== flushedContent : content !== savedContent);

  const refreshTree = useCallback(async () => {
    if (!id) return;
    setTree(await getTree(id));
  }, [id]);

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
    (async () => {
      try {
        // Guests cannot read the server config (host-only); defaults apply.
        const [p, t, cfg] = await Promise.all([getProject(id), getTree(id), isGuest ? null : getConfig()]);
        setProject(p);
        setTree(t);
        setConfig(cfg);
        setActivePath(p.mainFile);
        await loadIndexHints(id, t);
        const pdfProbe = await fetch(pdfUrl(id, Date.now()), { method: "GET" });
        if (pdfProbe.ok) setPdfBust(Date.now());
      } catch (err) {
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
        const file = await readProjectFile(id, pathBeingLoaded, { forceText });
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
    if (!id) return;
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
  }, [id, collab.commentsVersion]);

  useEffect(() => {
    if (!id) {
      setDiffOn(false);
      setDiffSince("");
      return;
    }
    const pref = readDiffHighlightPref(id);
    setDiffOn(pref.enabled);
    setDiffSince(pref.since);
  }, [id]);

  useEffect(() => {
    if (!id || !diffOn) {
      setDiffCommits([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const commits = await listProjectHistory(id, 80);
        if (cancelled) return;
        setDiffCommits(commits);
        if (commits.length === 0) return;
        setDiffSince((cur) => {
          if (cur && commits.some((c) => c.hash === cur || c.shortHash === cur)) return cur;
          const oldest = commits[commits.length - 1]!;
          persistDiffHighlight(id, true, oldest.hash);
          return oldest.hash;
        });
      } catch {
        if (!cancelled) setDiffCommits([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, diffOn]);

  useEffect(() => {
    if (!id || !diffOn || !diffSince) {
      setDiffBoxes([]);
      setDiffLines(null);
      setDiffFiles(null);
      setDiffWarning(null);
      setDiffLoading(false);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    (async () => {
      try {
        const result = await getDiffHighlights(id, diffSince);
        if (cancelled) return;
        setDiffBoxes(result.boxes);
        setDiffLines(result.lines);
        setDiffFiles(result.files);
        setDiffWarning(result.warning ?? null);
      } catch (err) {
        if (!cancelled) {
          setDiffBoxes([]);
          setDiffLines(null);
          setDiffFiles(null);
          setDiffWarning(err instanceof Error ? err.message : "Could not load additions");
        }
      } finally {
        if (!cancelled) setDiffLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, diffOn, diffSince, pdfBust]);

  const onDiffEnabledChange = useCallback(
    (on: boolean) => {
      setDiffOn(on);
      if (id) persistDiffHighlight(id, on, diffSince);
    },
    [id, diffSince],
  );

  const onDiffSinceChange = useCallback(
    (hash: string) => {
      setDiffSince(hash);
      if (id) persistDiffHighlight(id, diffOn, hash);
    },
    [id, diffOn],
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
        const file = await readProjectFile(id, pathBeingLoaded, { forceText });
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
        // Always paint disk content immediately so the buffer is never blank
        // while we wait for the Yjs room to finish syncing.
        setContent(file.content);
        setSavedContent(file.content);
        lastTextPathRef.current = pathBeingLoaded;

        // Prefer live collab when the room has synced. Never block forever on sync —
        // a large/stale ydoc can leave synced=false indefinitely (Save stuck on Loading…).
        // Keep disk content visible meanwhile.
        if (collab.doc && !collab.synced) {
          setFlushedContent(file.content);
          setLiveContent(file.content);
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
        setContent(file.content);
        setSavedContent(file.content);
        setFlushedContent(file.content);
        setLiveContent(file.content);
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
    collab.doc,
    collab.synced,
    collab.ensureFile,
  ]);

  useEffect(() => {
    if (!treeDragging) return;
    const onMove = (e: MouseEvent) => {
      const el = workspaceRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const w = Math.min(420, Math.max(160, e.clientX - rect.left));
      setTreeWidth(w);
    };
    const onUp = () => {
      setTreeDragging(false);
      localStorage.setItem("openleaf.treeWidth", String(treeWidth));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [treeDragging, treeWidth]);

  const runCompile = useCallback(async () => {
    if (!id || compileLock.current || !canCompile) return;
    compileLock.current = true;
    setStatus("compiling");
    setLog("");
    setLogOpen(true);
    try {
      const result = await compileProject(id, {
        onLog: (chunk) => setLog((prev) => prev + chunk),
      });
      setLog((prev) => prev || result.log);
      if (result.ok) {
        setStatus("ok");
        setPdfBust(Date.now());
        await refreshTree();
      } else {
        setStatus("err");
      }
    } catch (err) {
      setStatus("err");
      setLog((prev) => `${prev}\n${err instanceof Error ? err.message : "Compile failed"}`);
    } finally {
      compileLock.current = false;
    }
  }, [id, refreshTree, canCompile]);

  const save = useCallback(
    async (opts?: { compile?: boolean; silent?: boolean }) => {
      if (!id || !activePath || editMode === "binary") return;
      if (!fileReady) return;
      if (tooLargeBytes != null) return;
      if (readOnly) {
        if (!opts?.silent) setError("This share link is read-only.");
        return;
      }
      if (saveLock.current) return;
      saveLock.current = true;

      const wantCompile = opts?.compile === true && config?.latex.autoCompile !== false;
      setStatus("saving");
      if (!opts?.silent) setError(null);

      try {
        if (collabText) {
          const result = await flushCollab(id, {
            identityId: collab.identity?.id,
            message: `Save (${activePath})`,
          });
          if (result.git?.committed && result.git.hash) {
            setLastCommit(result.git.hash.slice(0, 7));
          }
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
          if (shouldCompile) await runCompile();
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
        if (shouldCompile) await runCompile();
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
      editMode,
      fileReady,
      collabText,
      yText,
      collab.identity?.id,
      readOnly,
      isGuest,
      refreshSession,
      tooLargeBytes,
    ],
  );

  // Autosave always on for editable text/base64 buffers (no compile — keep it light).
  useEffect(() => {
    if (!dirty || readOnly || !fileReady) return;
    if (status === "saving" || status === "compiling") return;
    const t = window.setTimeout(() => {
      void save({ compile: false, silent: true });
    }, 1500);
    return () => window.clearTimeout(t);
  }, [dirty, liveContent, content, readOnly, fileReady, status, save]);

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

  const onHighlightSinceCommit = useCallback(
    (commit: GitCommitInfo) => {
      setDiffOn(true);
      setDiffSince(commit.hash);
      if (id) persistDiffHighlight(id, true, commit.hash);
      showSyncToast(`Highlighting additions since ${commit.shortHash}`);
    },
    [id, showSyncToast],
  );

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
          const hit = await synctexForward(id, anchor.file, anchor.line, col);
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
    [id],
  );

  const onReverseSearch = useCallback(
    async (page: number, x: number, y: number) => {
      if (!id) return;
      try {
        const hit = await synctexLookup(id, page, x, y);
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
        if (target !== activePathRef.current) {
          setActivePath(target);
        }
      } catch {
        showSyncToast("No SyncTeX match — recompile?");
      }
    },
    [id, normalizeSynctexPath, showSyncToast],
  );

  const onPdfComment = useCallback(
    async (page: number, x: number, y: number) => {
      if (!id) return;
      try {
        const hit = await synctexLookup(id, page, x, y);
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
        setCommentsOpen(true);
        showSyncToast(`Comment @ ${target}:${hit.line}`);
      } catch {
        showSyncToast("No SyncTeX match — recompile?");
      }
    },
    [id, jumpToAnchor, normalizeSynctexPath, showSyncToast],
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
      setCommentsOpen(true);
    },
    [],
  );

  const commentMarks = useMemo(() => {
    if (!activePath) return [];
    return commentThreads
      .filter((t) => t.anchor.file === activePath)
      .map((t) => ({
        line: t.anchor.line,
        color: t.authorColor,
        resolved: t.resolved,
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
        const hit = await synctexForward(id, activePath, line, column);
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
    [id, activePath, showSyncToast],
  );

  const openPath = useCallback((path: string) => {
    setForceTextPath(null);
    setForceBase64Path(null);
    setActivePath(path);
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
    if (lastSavedAt) return `Last saved ${formatLastSaved(lastSavedAt)}`;
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

  if (error && !project) {
    return (
      <div className="home">
        <div className="error-banner">{error}</div>
        <Link to="/">← Back</Link>
      </div>
    );
  }

  return (
    <div className="editor-page">
      <div className="editor-toolbar">
        <div className="toolbar-cluster">
          <img className="toolbar-logo" src="/logo.png" alt="OpenLeaf logo" />
          {isGuest ? (
            <span className="badge share-guest-badge" title="You joined through a share link">
              Shared with you
            </span>
          ) : (
            <Link className="btn btn-ghost" to="/">
              ← Projects
            </Link>
          )}
          <strong style={{ letterSpacing: "-0.02em" }}>{project?.id ?? id}</strong>
          <span className="badge">{project?.engine ?? "pdflatex"}</span>
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
            title={lastSavedAt ? `Last saved ${formatLastSaved(lastSavedAt)}` : "Autosave is on — edits flush to disk shortly"}
          >
            {statusLabel}
          </span>
          {activePath && <span className="status-pill">{activePath}</span>}
          {editMode === "base64" && <span className="status-pill warn">base64</span>}
          {readOnly && <span className="status-pill warn">read-only</span>}
        </div>

        <div className="toolbar-cluster toolbar-collab">
          <div className="presence-strip" title="Connected editors">
            {presence.map((p) => (
              <span
                key={p.clientId}
                className={`presence-chip${collab.identity?.id === p.id ? " me" : ""}`}
                style={{ ["--presence" as string]: p.color }}
              >
                {p.name}
              </span>
            ))}
          </div>

          {isGuest && guest ? (
            <span className="identity-picker" title="Signed in as a guest">
              <span className="identity-picker-label">You</span>
              <span className="presence-chip me" style={{ ["--presence" as string]: guest.guest.color }}>
                {guest.guest.name}
              </span>
              <button
                type="button"
                className="btn btn-ghost"
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
            <span
              className="status-pill warn"
              title="Add identities in this project's openleaf.json"
            >
              No identities configured
            </span>
          )}
        </div>

        <div className="toolbar-actions">
          <ThemeToggle />
          {!isGuest && (
            <>
              {shareActive && (
                <button
                  type="button"
                  className={`btn share-timer-chip${shareUrgent ? " is-urgent" : ""}`}
                  onClick={() => setShareOpen(true)}
                  title={
                    shareExpiresAt === null
                      ? "Session has no automatic expiry — click to manage"
                      : shareExpiresAt
                        ? `Session ends ${new Date(shareExpiresAt).toLocaleString()} — click to extend`
                        : "Live share session — click to manage"
                  }
                >
                  <span className="share-timer-dot" aria-hidden>
                    ●
                  </span>
                  {shareTimerLabel}
                </button>
              )}
              {!shareActive && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShareOpen(true)}
                  title="Create a temporary public link"
                >
                  Share
                </button>
              )}
            </>
          )}
          {canHistory && (
            <button type="button" className="btn" onClick={() => setHistoryOpen(true)}>
              History{lastCommit ? ` (${lastCommit})` : ""}
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => {
              setHistoryOpen(false);
              setCommentsOpen(true);
            }}
          >
            Comments{openCommentCount ? ` (${openCommentCount})` : ""}
          </button>
          {!readOnly && (
            <button
              type="button"
              className="btn"
              onClick={() => void save({ compile: true })}
              disabled={
                !activePath || !fileReady || editMode === "binary" || tooLargeBytes != null || status === "saving"
              }
              title="Save now (autosave is already on). Also recompiles when auto-compile is enabled."
            >
              {status === "saving" ? "Saving…" : fileReady ? (collabText ? "Save & sync" : "Save") : "Loading…"}
            </button>
          )}
          {canCompile && (
            <button type="button" className="btn btn-primary" onClick={() => void runCompile()} disabled={status === "compiling"}>
              Recompile
            </button>
          )}
          {canDownload && (
            <>
              <a className="btn" href={downloadUrl(id, "pdf")} download={`${id}.pdf`}>
                PDF
              </a>
              <a className="btn" href={downloadUrl(id, "zip")} download={`${id}.zip`}>
                ZIP
              </a>
            </>
          )}
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
        />
      )}

      <HistoryPanel
        projectId={id}
        identityId={collab.identity?.id}
        canRestore={!isGuest}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onHighlightSince={config?.git?.enabled === false ? undefined : onHighlightSinceCommit}
        onRestored={() => {
          setHistoryOpen(false);
          showSyncToast("Restored snapshot — reloading file");
          // Force re-bind of active path from disk/CRDT
          const path = activePathRef.current;
          setActivePath(null);
          window.setTimeout(() => setActivePath(path), 0);
          void refreshTree();
        }}
      />

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
      />

      <div className="workspace" ref={workspaceRef}>
        <div className="split-row" style={{ flex: 1, minHeight: 0 }}>
          <div className="pane pane-tree" style={{ flex: `0 0 ${treeWidth}px` }}>
            <div className="pane-title">Files</div>
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
              readOnly={readOnly}
            />
          </div>
          <div
            className={`split-handle${treeDragging ? " active" : ""}`}
            onMouseDown={() => setTreeDragging(true)}
            role="separator"
            aria-orientation="vertical"
          />
          <div className="pane" style={{ flex: 1, minWidth: 0 }}>
            <SplitPane
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
                      <div className="pane-title">
                        Source{editMode === "base64" ? " (base64)" : ""}
                        <span
                          style={{
                            marginLeft: "0.6rem",
                            fontWeight: 500,
                            textTransform: "none",
                            letterSpacing: 0,
                          }}
                        >
                          Ctrl/Cmd+Click → PDF · Ctrl/Cmd+Alt+M → comment
                        </span>
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
                        readOnly={readOnly || (editMode === "text" && Boolean(collab.doc) && !yText)}
                        commentMarks={commentMarks}
                        onRequestComment={onRequestComment}
                      />
                    </>
                  )}
                </div>
              }
              right={
                <PdfViewer
                  url={pdfBust != null ? pdfUrl(id, pdfBust) : null}
                  onReverseSearch={onReverseSearch}
                  onCommentAt={(page, x, y) => void onPdfComment(page, x, y)}
                  highlight={pdfHighlight}
                  overlays={diffOn ? diffBoxes : undefined}
                  diffHighlight={
                    config?.git?.enabled === false
                      ? null
                      : {
                          enabled: diffOn,
                          since: diffSince,
                          commits: diffCommits,
                          lineCount: diffLines,
                          fileCount: diffFiles,
                          loading: diffLoading,
                          warning: diffWarning,
                          onEnabledChange: onDiffEnabledChange,
                          onSinceChange: onDiffSinceChange,
                        }
                  }
                />
              }
            />
          </div>
        </div>
        <CompileLog log={log} open={logOpen} onToggle={() => setLogOpen((v) => !v)} height={180} />
      </div>
    </div>
  );
}
