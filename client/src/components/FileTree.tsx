import { useEffect, useRef, useState } from "react";
import type { TreeNode } from "../api/types";

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

/** Reject drops into itself/descendant or into the directory it is already in. */
function isNoopOrCyclicDrop(from: string, toDir: string): boolean {
  if (toDir === from || toDir.startsWith(`${from}/`)) return true;
  return parentOf(from) === toDir;
}

function readDragPath(e: React.DragEvent): string | null {
  return e.dataTransfer.getData(DRAG_MIME) || null;
}

function NodeView({
  node,
  activePath,
  dragOverDir,
  onOpen,
  onContextMenu,
  onDragStartNode,
  onDirDragOver,
  onDirDragLeave,
  onDropInDir,
}: {
  node: TreeNode;
  activePath: string | null;
  dragOverDir: string | null;
  onOpen: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  onDragStartNode: (e: React.DragEvent, node: TreeNode) => void;
  onDirDragOver: (e: React.DragEvent, dir: string) => void;
  onDirDragLeave: (e: React.DragEvent, dir: string) => void;
  onDropInDir: (e: React.DragEvent, dir: string) => void;
}) {
  if (node.type === "directory") {
    return (
      <details className="tree-dir" open>
        <summary
          className={dragOverDir === node.path ? "drag-over" : ""}
          draggable
          onDragStart={(e) => onDragStartNode(e, node)}
          onDragOver={(e) => onDirDragOver(e, node.path)}
          onDragLeave={(e) => onDirDragLeave(e, node.path)}
          onDrop={(e) => onDropInDir(e, node.path)}
          onContextMenu={(e) => onContextMenu(e, node)}
        >
          {node.name}
        </summary>
        <div className="tree-children">
          {(node.children ?? []).map((child) => (
            <NodeView
              key={child.path}
              node={child}
              activePath={activePath}
              dragOverDir={dragOverDir}
              onOpen={onOpen}
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

  return (
    <button
      type="button"
      className={`tree-file${activePath === node.path ? " active" : ""}`}
      onClick={() => onOpen(node.path)}
      onContextMenu={(e) => onContextMenu(e, node)}
      draggable
      onDragStart={(e) => onDragStartNode(e, node)}
      onDragOver={(e) => onDirDragOver(e, parentOf(node.path))}
      onDragLeave={(e) => onDirDragLeave(e, parentOf(node.path))}
      onDrop={(e) => onDropInDir(e, parentOf(node.path))}
      title={node.path}
    >
      {node.name}
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
  canMutateActive,
  readOnly = false,
}: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadDirRef = useRef<string>("");

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
        </div>
      ) : (
      <div className="file-tree-actions">
        <button type="button" className="btn btn-ghost tree-action" onClick={() => onNewFile()} title="New file">
          + File
        </button>
        <button type="button" className="btn btn-ghost tree-action" onClick={() => onNewFolder()} title="New folder">
          + Dir
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
        <button
          type="button"
          className="btn btn-ghost tree-action"
          onClick={() => onRename()}
          disabled={!canMutateActive}
          title="Rename selected"
        >
          Rename
        </button>
        <button
          type="button"
          className="btn btn-ghost tree-action"
          onClick={() => onDelete()}
          disabled={!canMutateActive}
          title="Delete selected"
        >
          Del
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
        {nodes.map((node) => (
          <NodeView
            key={node.path}
            node={node}
            activePath={activePath}
            dragOverDir={dragOverDir}
            onOpen={onOpen}
            onContextMenu={openMenu}
            onDragStartNode={onDragStartNode}
            onDirDragOver={onDirDragOver}
            onDirDragLeave={onDirDragLeave}
            onDropInDir={onDropInDir}
          />
        ))}
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
              <div className="context-menu-sep" />
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
        </div>
      )}
    </div>
  );
}
