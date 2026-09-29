import { useEffect, useMemo, useState } from "react";
import { getFileAccess, putFileAccessRules } from "../api/client";
import type { FileAccessLevel, FileAccessRule, FileAccessView, TreeNode } from "../api/types";

type Actor = "local" | "device" | "guest";

type Props = {
  projectId: string;
  open: boolean;
  onClose: () => void;
  actor: Actor;
  nodes: TreeNode[];
  onChanged: () => void;
};

function flatten(nodes: TreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(node.path);
    if (node.children) flatten(node.children, out);
  }
  return out;
}

function canRemove(rule: FileAccessRule, actor: Actor): boolean {
  if (actor === "guest") return false;
  if (actor === "device" && rule.level === "local") return false;
  return true;
}

export function FileAccessDrawer({ projectId, open, onClose, actor, nodes, onChanged }: Props) {
  const [view, setView] = useState<FileAccessView | null>(null);
  const [path, setPath] = useState("");
  const [level, setLevel] = useState<FileAccessLevel>("host");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paths = useMemo(() => flatten(nodes), [nodes]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    void getFileAccess(projectId)
      .then((next) => {
        if (!cancelled) setView(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load file access");
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  if (!open) return null;

  async function save(body: { upsert?: { path: string; level: FileAccessLevel }[]; delete?: string[] }) {
    setBusy(true);
    setError(null);
    try {
      const next = await putFileAccessRules(projectId, body);
      setView(next);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update file access");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="history-drawer file-access-drawer" role="dialog" aria-label="File access">
      <div className="history-drawer-head">
        <strong>File access</strong>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="history-hint">
        Rules only take edit access away. The most specific path wins, and protected files stay locked to this computer.
      </p>
      {error && <div className="error-banner">{error}</div>}
      <ul className="file-access-rules">
        {(view?.rules ?? []).length === 0 && <li className="share-muted">No extra locks.</li>}
        {(view?.rules ?? []).map((rule) => (
          <li key={rule.path}>
            <code>{rule.path}</code>
            <span className="tree-access-label">{rule.level}</span>
            <span className="share-muted">set by {rule.setBy}</span>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || !canRemove(rule, actor)}
              title={canRemove(rule, actor) ? "Remove this rule" : "Only this computer can remove this lock"}
              onClick={() => void save({ delete: [rule.path] })}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="file-access-add"
        onSubmit={(e) => {
          e.preventDefault();
          const next = path.trim();
          if (!next) return;
          void save(level === "everyone" ? { delete: [next] } : { upsert: [{ path: next, level }] }).then(() => setPath(""));
        }}
      >
        <label>
          Add rule
          <input
            list="file-access-paths"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="path in the project"
            aria-label="Path to lock"
          />
        </label>
        <datalist id="file-access-paths">
          {paths.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
        <select value={level} aria-label="Who can edit" onChange={(e) => setLevel(e.target.value as FileAccessLevel)}>
          <option value="everyone">Anyone with edit access</option>
          <option value="host">Only me</option>
          <option value="local">Only on this computer</option>
        </select>
        <button type="submit" className="btn" disabled={busy || actor === "guest" || !path.trim()}>
          Add rule
        </button>
      </form>
      <details className="file-access-protected">
        <summary>Always protected</summary>
        <p>These patterns run code or hold settings on the host computer. No setting can unlock them.</p>
        <ul>
          {(view?.protected ?? []).map((item) => (
            <li key={item.pattern}>
              <code>{item.pattern}</code>
              <span className="share-muted">{item.reason}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
