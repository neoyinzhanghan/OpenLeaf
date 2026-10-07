import { useEffect, useRef, useState } from "react";
import type { FileAccessLevel, FileChangeDiff, TreeNode } from "../api/types";

export type FileChangeHint = Pick<FileChangeDiff, "status" | "additions" | "deletions">;

type Props = {
  nodes: TreeNode[];
  activePath: string | null;
  onOpen: (path: string) => void;
  onNewFile: (dir?: string) => void;
  onNewFolder: (dir?: string) => void;
  onUpload: (files: FileList, dir?: string) => void;
  onDelete: (path?: string) => void;
  onRename: (path?: string) => void;
  onMove: (from: string, toDir: string) => void;
  canMutateActive: boolean;
  /** Hide every mutating control (read-only guest). */
  readOnly?: boolean;
  /** Who is looking at the tree. Guests see locks; only local and device can change them. */
  actor?: "local" | "device" | "guest";
  onSetAccess?: (path: string, level: FileAccessLevel) => void;
  /** When Differences is on — Cursor-style +/− badges per path. */
  fileChanges?: Record<string, FileChangeHint> | null;
};

type MenuState = {
  x: number;
  y: number;
  /** null = right-click on empty tree background (project root) */
  node: TreeNode | null;
};

const DRAG_MIME = "application/x-openleaf-path";

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

/** Directory paths that contain `filePath` (not including the file itself). */
function ancestorsOf(filePath: string | null): string[] {
  if (!filePath) return [];
  const parts = filePath.split("/").filter(Boolean);
  const dirs: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    dirs.push(parts.slice(0, i).join("/"));
  }
  return dirs;
}

/** Reject drops into itself/descendant or into the directory it is already in. */
function isNoopOrCyclicDrop(from: string, toDir: string): boolean {
  if (toDir === from || toDir.startsWith(`${from}/`)) return true;
  return parentOf(from) === toDir;
}

function readDragPath(e: React.DragEvent): string | null {
  return e.dataTransfer.getData(DRAG_MIME) || null;
}

function accessTitle(node: TreeNode): string | undefined {
  const access = node.access;
  if (!access) return undefined;
  if (access.protected) {
    return "Protected: runs code or holds settings on the host computer. Edit it on that computer.";
  }
  if (access.level === "host") {
    return "Guests and AI links cannot edit this. This computer and paired devices can.";
  }
  if (access.level === "local") {
    return "Only this computer can edit this. Phones, guests, and AI links are read-only.";
  }
  return undefined;
}

function AccessMark({ node }: { node: TreeNode }) {
  const access = node.access;
  if (!access) return null;
  const title = accessTitle(node);
  if (access.protected) {
    return (
      <span className="tree-access" title={title}>
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden>
          <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      </span>
    );
  }
  if (access.level !== "host" && access.level !== "local") return null;
  return (
    <span className="tree-access" title={title}>
      <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden>
        <rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
      <span className="tree-access-label">{access.level}</span>
    </span>
  );
}

function WhoCanEdit({
  node,
  actor,
  onSetAccess,
  close,
}: {
  node: TreeNode;
  actor: "local" | "device" | "guest";
  onSetAccess?: (path: string, level: FileAccessLevel) => void;
  close: () => void;
}) {
  const access = node.access;
  if (access?.protected) {
    return (
      <button type="button" className="context-menu-access" disabled title={accessTitle(node)}>
        Who can edit
      </button>
    );
  }
  const level = access?.level ?? "everyone";
  const guestBlocked = actor === "guest";
  const localLock = level === "local" && actor !== "local";
  const reason = guestBlocked
    ? "Only the host can change who edits a file."
    : localLock
      ? "Only this computer can loosen a lock set for this computer."
      : "";
  const choices: { level: FileAccessLevel; label: string }[] = [
    { level: "everyone", label: "Anyone with edit access" },
    { level: "host", label: "Only me" },
    { level: "local", label: "Only on this computer" },
  ];
  return (
    <fieldset className="context-menu-access">
      <legend>Who can edit</legend>
      {choices.map((choice) => {
        const disabled =
          !onSetAccess ||
          guestBlocked ||
          (localLock && choice.level !== "local") ||
          (actor === "device" && choice.level === "everyone" && level === "local");
        return (
          <label key={choice.level} className={disabled ? "is-disabled" : ""}>
            <input
              type="radio"
              name={`access-${node.path}`}
              checked={level === choice.level}
              disabled={disabled}
              onChange={() => {
                onSetAccess?.(node.path, choice.level);
                close();
              }}
            />
            {choice.label}
          </label>
        );
      })}
      {reason && <p className="context-menu-access-reason">{reason}</p>}
    </fieldset>
  );
}

function ChangeBadge({ hint }: { hint: FileChangeHint }) {
  const letter =
    hint.status === "added" ? "A" : hint.status === "deleted" ? "D" : hint.status === "renamed" ? "R" : "M";
  return (
    <span className={`tree-change-badge tree-change-badge--${hint.status}`} title={`${hint.status}: +${hint.additions} −${hint.deletions}`}>
      <span className="tree-change-letter">{letter}</span>
      {hint.additions > 0 && <span className="tree-change-add">+{hint.additions}</span>}
      {hint.deletions > 0 && <span className="tree-change-del">−{hint.deletions}</span>}
    </span>
  );
}

function NodeView({
  node,
  activePath,
  dragOverDir,
  expanded,
  fileChanges,
  onOpen,
  onToggleDir,
  onContextMenu,
  onDragStartNode,
  onDirDragOver,
  onDirDragLeave,
  onDropInDir,
}: {
  node: TreeNode;
  activePath: string | null;
  dragOverDir: string | null;
  expanded: ReadonlySet<string>;
  fileChanges?: Record<string, FileChangeHint> | null;
  onOpen: (path: string) => void;
  onToggleDir: (path: string, open: boolean) => void;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  onDragStartNode: (e: React.DragEvent, node: TreeNode) => void;
  onDirDragOver: (e: React.DragEvent, dir: string) => void;
  onDirDragLeave: (e: React.DragEvent, dir: string) => void;
  onDropInDir: (e: React.DragEvent, dir: string) => void;
}) {
  if (node.type === "directory") {
    return (
      <details
        className="tree-dir"
        open={expanded.has(node.path)}
        onToggle={(e) => {
          e.stopPropagation();
          const want = e.currentTarget.open;
          if (want !== expanded.has(node.path)) onToggleDir(node.path, want);
        }}
      >
        <summary
          className={dragOverDir === node.path ? "drag-over" : ""}
          draggable
          onDragStart={(e) => onDragStartNode(e, node)}
          onDragOver={(e) => onDirDragOver(e, node.path)}
          onDragLeave={(e) => onDirDragLeave(e, node.path)}
          onDrop={(e) => onDropInDir(e, node.path)}
          onContextMenu={(e) => onContextMenu(e, node)}
        >
          <span className="tree-file-name">{node.name}</span>
          <AccessMark node={node} />
        </summary>
        <div className="tree-children">
          {(node.children ?? []).map((child) => (
            <NodeView
              key={child.path}
              node={child}
              activePath={activePath}
              dragOverDir={dragOverDir}
              expanded={expanded}
              fileChanges={fileChanges}
              onOpen={onOpen}
              onToggleDir={onToggleDir}
              onContextMenu={onContextMenu}
              onDragStartNode={onDragStartNode}
              onDirDragOver={onDirDragOver}
              onDirDragLeave={onDirDragLeave}
              onDropInDir={onDropInDir}
            />
          ))}
        </div>
      </details>
    );
  }

  const hint = fileChanges?.[node.path];
  return (
    <button
      type="button"
      className={`tree-file${activePath === node.path ? " active" : ""}${hint ? ` tree-file--${hint.status}` : ""}`}
      onClick={() => onOpen(node.path)}
      onContextMenu={(e) => onContextMenu(e, node)}
      draggable
      onDragStart={(e) => onDragStartNode(e, node)}
      onDragOver={(e) => onDirDragOver(e, parentOf(node.path))}
      onDragLeave={(e) => onDirDragLeave(e, parentOf(node.path))}
      onDrop={(e) => onDropInDir(e, parentOf(node.path))}
      title={accessTitle(node) ?? node.path}
    >
      <span className="tree-file-name">{node.name}</span>
      <AccessMark node={node} />
      {hint && <ChangeBadge hint={hint} />}
    </button>
  );
}

export function FileTree({
  nodes,
  activePath,
  onOpen,
  onNewFile,
  onNewFolder,
  onUpload,
  onDelete,
  onRename,
  onMove,
  canMutateActive: _canMutateActive,
  readOnly = false,
  fileChanges = null,
  actor = "local",
  onSetAccess,
}: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [showBuildFiles, setShowBuildFiles] = useState(false);
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(ancestorsOf(activePath)));
  const treeKey = nodes.map((n) => n.path).join("\0");
  const menuRef = useRef<HTMLDivElement>(null);
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadDirRef = useRef<string>("");

  // Reset when the project tree identity changes; keep only ancestors of the open file.
  useEffect(() => {
    setExpanded(new Set(ancestorsOf(activePathRef.current)));
  }, [treeKey]);

  // Opening a nested file expands its ancestors so it stays visible.
  useEffect(() => {
    if (!activePath) return;
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const dir of ancestorsOf(activePath)) {
        if (!next.has(dir)) {
          next.add(dir);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activePath]);

  const onToggleDir = (path: string, open: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  // Keep the menu on-screen once it renders
  useEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - rect.width - 8);
    const y = Math.min(menu.y, window.innerHeight - rect.height - 8);
    if (x !== menu.x || y !== menu.y) setMenu({ ...menu, x, y });
  }, [menu]);

  const openMenu = (e: React.MouseEvent, node: TreeNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    if (readOnly && !(node && node.type === "file")) return;
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  const onDragStartNode = (e: React.DragEvent, node: TreeNode) => {
    e.stopPropagation();
    e.dataTransfer.setData(DRAG_MIME, node.path);
    e.dataTransfer.setData("text/plain", node.path);
    e.dataTransfer.effectAllowed = "move";
  };

  const acceptsDrop = (e: React.DragEvent): boolean =>
    e.dataTransfer.types.includes(DRAG_MIME) || e.dataTransfer.types.includes("Files");

  const onDirDragOver = (e: React.DragEvent, dir: string) => {
    if (!acceptsDrop(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes("Files") ? "copy" : "move";
    setDragOverDir(dir);
  };

  const onDirDragLeave = (e: React.DragEvent, dir: string) => {
    e.stopPropagation();
    setDragOverDir((cur) => (cur === dir ? null : cur));
  };

  const onDropInDir = (e: React.DragEvent, dir: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverDir(null);
    if (e.dataTransfer.files.length > 0) {
      onUpload(e.dataTransfer.files, dir);
      return;
    }
    const from = readDragPath(e);
    if (!from || isNoopOrCyclicDrop(from, dir)) return;
    onMove(from, dir);
  };

  const pickUploadInto = (dir: string) => {
    uploadDirRef.current = dir;
    uploadInputRef.current?.click();
  };

  const runMenuAction = (action: () => void) => {
    setMenu(null);
    action();
  };

  const menuNode = menu?.node ?? null;
  const menuDir = menuNode
    ? menuNode.type === "directory"
      ? menuNode.path
      : parentOf(menuNode.path)
    : "";

  return (
    <div className="file-tree-wrap">
      {readOnly ? (
        <div className="file-tree-actions">
          <span className="status-pill warn" title="This share link is read-only">
            Read-only
          </span>
          <button type="button" className="btn btn-ghost tree-action" onClick={() => setShowBuildFiles((v) => !v)}>
            {showBuildFiles ? "Hide build files" : "Show build files"}
          </button>
        </div>
      ) : (
        <div className="file-tree-actions">
          <button type="button" className="btn btn-ghost tree-action" onClick={() => onNewFile()} title="New file">
            New
          </button>
          <button type="button" className="btn btn-ghost tree-action" onClick={() => onNewFolder()} title="New folder">
            Folder
          </button>
          <label className="btn btn-ghost tree-action" title="Upload into project">
            Upload
            <input
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) onUpload(e.target.files);
                e.currentTarget.value = "";
              }}
            />
          </label>
          <button type="button" className="btn btn-ghost tree-action" onClick={() => setShowBuildFiles((v) => !v)}>
            {showBuildFiles ? "Hide build files" : "Show build files"}
          </button>
        </div>
      )}
      <div
        className={`file-tree${dragOverDir === "" ? " drag-over-root" : ""}`}
        onContextMenu={(e) => openMenu(e, null)}
        onDragOver={(e) => onDirDragOver(e, "")}
        onDragLeave={(e) => onDirDragLeave(e, "")}
        onDrop={(e) => onDropInDir(e, "")}
      >
        {nodes.length === 0 && !(fileChanges && Object.keys(fileChanges).length > 0) ? (
          <div className="empty-hint tree-empty">
            <strong>No files yet</strong>
            <p>{readOnly ? "This share has an empty tree." : "Use New / Folder / Upload, or right-click here."}</p>
          </div>
        ) : null}
        {(showBuildFiles ? nodes : nodes.filter((node) => node.path !== ".openleaf" && !node.path.startsWith(".openleaf/"))).map((node) => (
          <NodeView
            key={node.path}
            node={node}
            activePath={activePath}
            dragOverDir={dragOverDir}
            expanded={expanded}
            fileChanges={fileChanges}
            onOpen={onOpen}
            onToggleDir={onToggleDir}
            onContextMenu={openMenu}
            onDragStartNode={onDragStartNode}
            onDirDragOver={onDirDragOver}
            onDirDragLeave={onDirDragLeave}
            onDropInDir={onDropInDir}
          />
        ))}
        {fileChanges &&
          Object.entries(fileChanges)
            .filter(([, h]) => h.status === "deleted")
            .map(([path, hint]) => {
              const name = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
              return (
                <button
                  key={`deleted:${path}`}
                  type="button"
                  className={`tree-file tree-file--deleted tree-file--ghost${activePath === path ? " active" : ""}`}
                  onClick={() => onOpen(path)}
                  title={`${path} (deleted since snapshot)`}
                >
                  <span className="tree-file-name">{name}</span>
                  <ChangeBadge hint={hint} />
                </button>
              );
            })}
      </div>

      {/* Hidden input backing the "Upload here" context-menu action */}
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onUpload(e.target.files, uploadDirRef.current);
          e.currentTarget.value = "";
        }}
      />

      {menu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {menuNode && menuNode.type === "file" && (
            <>
              <button type="button" onClick={() => runMenuAction(() => onOpen(menuNode.path))}>
                Open
              </button>
              {!readOnly && <div className="context-menu-sep" />}
            </>
          )}
          {!readOnly && (
            <>
              <button type="button" onClick={() => runMenuAction(() => onNewFile(menuDir))}>
                New file{menuDir ? ` in ${menuDir}/` : ""}
              </button>
              <button type="button" onClick={() => runMenuAction(() => onNewFolder(menuDir))}>
                New folder{menuDir ? ` in ${menuDir}/` : ""}
              </button>
              <button type="button" onClick={() => runMenuAction(() => pickUploadInto(menuDir))}>
                Upload here
              </button>
              {menuNode && (
                <>
                  <div className="context-menu-sep" />
                  <button type="button" onClick={() => runMenuAction(() => onRename(menuNode.path))}>
                    Rename / Move…
                  </button>
                  <button
                    type="button"
                    className="context-menu-danger"
                    onClick={() => runMenuAction(() => onDelete(menuNode.path))}
                  >
                    Delete {menuNode.type === "directory" ? "folder" : "file"}
                  </button>
                </>
              )}
            </>
          )}
          {menuNode && (
            <WhoCanEdit node={menuNode} actor={actor} onSetAccess={onSetAccess} close={() => setMenu(null)} />
          )}
        </div>
      )}
    </div>
  );
}
