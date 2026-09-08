import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type * as Y from "yjs";
import {
  compileProject,
  createProjectFile,
  deleteProjectPath,
  downloadUrl,
  getConfig,
  getProject,
  getTree,
  mkdirProjectPath,
  pdfUrl,
  readProjectFile,
  renameProjectPath,
  synctexForward,
  synctexLookup,
  writeProjectFile,
} from "../api/client";
import type { AppConfig, ProjectMeta, TreeNode } from "../api/types";
import { guestLogout } from "../api/share";
import { flushCollab, useProjectCollab } from "../collab/useProjectCollab";
import { BinaryPane } from "../components/BinaryPane";
import { CodeEditor } from "../components/CodeEditor";
import { CompileLog } from "../components/CompileLog";
import { FileTree } from "../components/FileTree";
import { HistoryPanel } from "../components/HistoryPanel";
import { PdfViewer, type PdfHighlight } from "../components/PdfViewer";
import { SharePanel } from "../components/SharePanel";
import { SplitPane } from "../components/SplitPane";
import { ThemeToggle } from "../components/ThemeToggle";
import { extractCitations, extractLabels } from "../latex/completions";
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
  const [lastCommit, setLastCommit] = useState<string | null>(null);
  const compileLock = useRef(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const [fileReady, setFileReady] = useState(false);

  const collabText = editMode === "text" && yText != null;
  const dirty =
    editMode !== "binary" &&
    fileReady &&
    (collabText ? false : content !== savedContent);

  const refreshTree = useCallback(async () => {
    if (!id) return;
    setTree(await getTree(id));
  }, [id]);

  const loadIndexHints = useCallback(async (projectId: string, nodes: TreeNode[]) => {
    const files = flattenFiles(nodes);
    const bibPaths = files.filter((f) => f.endsWith(".bib"));
    const texPaths = files.filter((f) => f.endsWith(".tex") && !f.includes(".openleaf/"));
    const bibTexts = await Promise.all(
      bibPaths.map(async (f) => {
        try {
          const file = await readProjectFile(projectId, f, { forceText: true });
          return file.content;
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

  useEffect(() => {
    if (!id || !activePath) return;
    let cancelled = false;
    const pathBeingLoaded = activePath;
    setFileReady(false);
    setYText(null);
    (async () => {
      try {
        const forceText = forceTextPath === pathBeingLoaded;
        const forceBase64 = forceBase64Path === pathBeingLoaded;
        const file = await readProjectFile(id, pathBeingLoaded, { forceText });
        if (cancelled || activePathRef.current !== pathBeingLoaded) return;
        setError(null);
        if (forceBase64 || (!file.text && !forceText)) {
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
          setFileReady(true);
          setStatus("idle");
          return;
        }

        setBinaryMeta(null);
        setEditMode("text");

        // Wait for collab sync before binding — avoids dropping pre-sync keystrokes
        if (collab.doc && !collab.synced) {
          setFileReady(false);
          setStatus("idle");
          return;
        }

        if (collab.doc && collab.synced) {
          const text = await collab.ensureFile(pathBeingLoaded);
          if (cancelled || activePathRef.current !== pathBeingLoaded) return;
          if (text) {
            setYText(text);
            setContent(text.toString());
            setSavedContent(text.toString());
            setFileReady(true);
            setStatus("ok");
            return;
          }
        }

        // Fallback when collab unavailable: controlled editor
        setYText(null);
        setContent(file.content);
        setSavedContent(file.content);
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

  const save = useCallback(async () => {
    if (!id || !activePath || editMode === "binary") return;
    if (!fileReady) return;
    if (readOnly) {
      setError("This share link is read-only.");
      return;
    }

    // Collaborative text: flush CRDT → disk, then optional compile
    if (collabText) {
      setStatus("saving");
      setError(null);
      try {
        const result = await flushCollab(id, {
          identityId: collab.identity?.id,
          message: `Save & sync (${activePath})`,
        });
        if (result.git?.committed && result.git.hash) {
          setLastCommit(result.git.hash.slice(0, 7));
        }
        const text = yText?.toString() ?? "";
        if (activePath.endsWith(".bib")) setCitations(extractCitations(text));
        if (activePath.endsWith(".tex")) {
          setExtraLabels((prev) => {
            const set = new Set([...prev, ...extractLabels(text)]);
            return [...set].sort();
          });
        }
        const shouldCompile =
          config?.latex.autoCompile !== false &&
          (activePath.endsWith(".tex") ||
            activePath.endsWith(".bib") ||
            activePath.endsWith(".cls") ||
            activePath.endsWith(".sty") ||
            activePath.includes("figures/"));
        if (shouldCompile) await runCompile();
        else setStatus("ok");
      } catch (err) {
        setStatus("err");
        setError(err instanceof Error ? err.message : "Flush failed");
      }
      return;
    }

    if (content.length === 0 && savedContent.length > 0 && activePath.endsWith(".tex")) {
      setError("Refusing to save empty .tex over non-empty content.");
      return;
    }
    setStatus("saving");
    setError(null);
    try {
      const encoding = editMode === "base64" ? "base64" : "utf8";
      await writeProjectFile(id, activePath, content, encoding);
      setSavedContent(content);
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
        config?.latex.autoCompile !== false &&
        encoding === "utf8" &&
        (activePath.endsWith(".tex") ||
          activePath.endsWith(".bib") ||
          activePath.endsWith(".cls") ||
          activePath.endsWith(".sty") ||
          activePath.endsWith(".png") ||
          activePath.includes("figures/"));
      if (shouldCompile) {
        await runCompile();
      } else {
        setStatus("ok");
      }
    } catch (err) {
      setStatus("err");
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }, [
    id,
    activePath,
    content,
    savedContent,
    config,
    runCompile,
    editMode,
    fileReady,
    collabText,
    yText,
    collab.identity?.id,
    readOnly,
  ]);

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

  const onReverseSearch = useCallback(
    async (page: number, x: number, y: number) => {
      if (!id) return;
      try {
        const hit = await synctexLookup(id, page, x, y);
        // Guard against relocated-checkout SyncTeX paths (e.g. ../../../PaperFlow/.../sections/x.tex)
        let target = hit.input.replace(/\\/g, "/").replace(/^\.\//, "");
        if (target.split("/").includes("..") || target.startsWith("/")) {
          const marker = `/${id}/`;
          const idx = `/${target}`.replace(/\/+/g, "/").lastIndexOf(marker);
          if (idx >= 0) {
            target = `/${target}`.replace(/\/+/g, "/").slice(idx + marker.length);
          } else {
            showSyncToast("Stale SyncTeX paths — hit Recompile");
            return;
          }
        }
        if (!target || target.split("/").includes("..")) {
          showSyncToast("No SyncTeX match — recompile?");
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
    [id, showSyncToast],
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
    if (collabText && status === "idle") {
      if (collab.status === "connecting") return "Connecting…";
      if (collab.status === "connected" && collab.synced) return "Live";
      if (collab.status === "connected") return "Syncing…";
    }
    switch (status) {
      case "dirty":
        return "Unsaved";
      case "saving":
        return collabText ? "Flushing…" : "Saving…";
      case "compiling":
        return "Compiling…";
      case "ok":
        return collabText ? "Live" : "Up to date";
      case "err":
        return "Error";
      default:
        return collab.synced ? "Live" : "Ready";
    }
  }, [status, collabText, collab.status, collab.synced]);

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
          <span className={`status-pill ${status === "ok" && collabText ? "ok" : status}`}>{statusLabel}</span>
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
            <button
              type="button"
              className={`btn${shareActive ? " share-live" : ""}`}
              onClick={() => setShareOpen(true)}
              title={shareActive ? "Public link is live — manage" : "Create a temporary public link"}
            >
              {shareActive ? "● Live link" : "Share"}
            </button>
          )}
          {canHistory && (
            <button type="button" className="btn" onClick={() => setHistoryOpen(true)}>
              History{lastCommit ? ` (${lastCommit})` : ""}
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              className="btn"
              onClick={() => void save()}
              disabled={!activePath || !fileReady || editMode === "binary" || status === "saving"}
            >
              {fileReady ? (collabText ? "Save & sync" : "Save") : "Loading…"}
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
          onActiveChange={setShareActive}
        />
      )}

      <HistoryPanel
        projectId={id}
        identityId={collab.identity?.id}
        canRestore={!isGuest}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
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
                  {editMode === "binary" && activePath && binaryMeta ? (
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
                          Ctrl/Cmd+Click → PDF
                        </span>
                      </div>
                      <CodeEditor
                        path={activePath}
                        value={content}
                        onChange={setContent}
                        onSave={() => void save()}
                        jumpTo={jumpTo}
                        citations={citations}
                        labels={labels}
                        onForwardSearch={(line, col) => void onForwardSearch(line, col)}
                        yText={collabText ? yText : null}
                        awareness={collabText ? collab.awareness : null}
                        readOnly={readOnly}
                      />
                    </>
                  )}
                </div>
              }
              right={
                <PdfViewer
                  url={pdfBust != null ? pdfUrl(id, pdfBust) : null}
                  onReverseSearch={onReverseSearch}
                  highlight={pdfHighlight}
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
