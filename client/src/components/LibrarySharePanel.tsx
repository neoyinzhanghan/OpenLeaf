import { useCallback, useEffect, useState } from "react";
import {
  createLibraryShare,
  importLibraryShare,
  listLibraryShares,
  stopLibraryShare,
  type LibraryShareHostView,
  type LibraryShareRole,
} from "../api/libraryShare";
import { copyText } from "../lib/clipboard";

const TTL_PRESETS: Array<{ label: string; days: number | null }> = [
  { label: "1 day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "No expiry", days: null },
];

type Props = {
  open: boolean;
  onClose: () => void;
  /** Papers currently checked in the library list. */
  citekeys: string[];
  /** Active collection filter, if any. */
  collectionId?: string | null;
  collectionName?: string | null;
};

export function LibrarySharePanel({ open, onClose, citekeys, collectionId, collectionName }: Props) {
  const [shares, setShares] = useState<LibraryShareHostView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [lastInvite, setLastInvite] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [role, setRole] = useState<LibraryShareRole>("commenter");
  const [allowPdf, setAllowPdf] = useState(true);
  const [allowExport, setAllowExport] = useState(true);
  const [ttlDays, setTtlDays] = useState<number | null>(7);
  const [riskAck, setRiskAck] = useState(false);
  const [shareCollection, setShareCollection] = useState(Boolean(collectionId));

  const [importUrl, setImportUrl] = useState("");
  const [importResult, setImportResult] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { shares: list } = await listLibraryShares();
      setShares(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setRiskAck(false);
    setLastInvite(null);
    setShareCollection(Boolean(collectionId));
    setTitle(
      collectionId && collectionName
        ? collectionName
        : citekeys.length === 1
          ? ""
          : citekeys.length
            ? `${citekeys.length} papers`
            : "",
    );
    void refresh();
    const t = window.setInterval(() => void refresh(), 8000);
    return () => window.clearInterval(t);
  }, [open, citekeys, collectionId, collectionName, refresh]);

  if (!open) return null;

  const canCreate = shareCollection ? Boolean(collectionId) : citekeys.length > 0;

  const onCreate = async () => {
    if (!riskAck) {
      setError("Confirm the public-link risk acknowledgment before creating a link");
      return;
    }
    if (!canCreate) {
      setError("Select papers (checkboxes) or share the current collection");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const expiresAt = ttlDays == null ? null : Date.now() + ttlDays * 24 * 3600_000;
      const { share, inviteUrl } = await createLibraryShare({
        citekeys: shareCollection ? undefined : citekeys,
        collectionId: shareCollection ? collectionId : null,
        settings: {
          title: title.trim() || undefined,
          role,
          allowPdf,
          allowExport,
          expiresAt,
        },
        riskAck: true,
      });
      setLastInvite(inviteUrl);
      setShares((prev) => [share, ...prev.filter((s) => s.id !== share.id)]);
      setRiskAck(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onStop = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await stopLibraryShare(id);
      setShares((prev) => prev.filter((s) => s.id !== id));
      if (lastInvite?.includes(id)) setLastInvite(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onCopy = async (url: string) => {
    const ok = await copyText(url);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  const onImport = async () => {
    const raw = importUrl.trim();
    if (!raw) return;
    setBusy(true);
    setError(null);
    setImportResult(null);
    try {
      const result = await importLibraryShare(
        raw.startsWith("{") ? { bundle: JSON.parse(raw) } : { inviteUrl: raw },
      );
      setImportResult(
        `Added ${result.count} paper${result.count === 1 ? "" : "s"}` +
          (result.skipped.length ? ` · skipped ${result.skipped.length}` : ""),
      );
      setImportUrl("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="share-drawer library-share-drawer" role="dialog" aria-label="Share papers">
      <div className="share-body">
        <div className="share-cred" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <div>
            <p className="share-section-title" style={{ margin: 0 }}>
              Share papers
            </p>
            <p className="share-muted" style={{ margin: "4px 0 0" }}>
              Private link · guests add to their library · shared notes
            </p>
          </div>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {error ? <div className="share-error">{error}</div> : null}

        <div className="share-section">
          <p className="share-section-title">New link</p>
          <label className="share-field-label">
            Title
            <input
              className="library-share-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Shared reading list"
              disabled={busy}
            />
          </label>

          <div className="library-share-scope">
            <label className="share-check">
              <input
                type="radio"
                name="lib-share-scope"
                checked={!shareCollection}
                onChange={() => setShareCollection(false)}
                disabled={busy}
              />
              <span>
                Selected papers <span className="share-muted">({citekeys.length})</span>
              </span>
            </label>
            <label className="share-check">
              <input
                type="radio"
                name="lib-share-scope"
                checked={shareCollection}
                onChange={() => setShareCollection(true)}
                disabled={busy || !collectionId}
              />
              <span>
                Current collection{" "}
                <span className="share-muted">
                  ({collectionName ?? "none"})
                </span>
              </span>
            </label>
          </div>

          <label className="share-field-label">
            Guest role
            <select
              className="library-inline-select"
              value={role}
              onChange={(e) => setRole(e.target.value as LibraryShareRole)}
              disabled={busy}
            >
              <option value="viewer">Viewer — read only</option>
              <option value="commenter">Commenter — shared notes</option>
            </select>
          </label>

          <label className="share-field-label">
            Expires
            <select
              className="library-inline-select"
              value={ttlDays === null ? "none" : String(ttlDays)}
              onChange={(e) => {
                const v = e.target.value;
                setTtlDays(v === "none" ? null : Number(v));
              }}
              disabled={busy}
            >
              {TTL_PRESETS.map((p) => (
                <option key={String(p.days)} value={p.days === null ? "none" : String(p.days)}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="share-check">
            <input type="checkbox" checked={allowPdf} onChange={(e) => setAllowPdf(e.target.checked)} disabled={busy} />
            <span>Share attached PDFs</span>
          </label>
          <label className="share-check">
            <input
              type="checkbox"
              checked={allowExport}
              onChange={(e) => setAllowExport(e.target.checked)}
              disabled={busy}
            />
            <span>Allow “Add to my library” / export</span>
          </label>

          <div className="share-risk" role="group" aria-labelledby="lib-share-risk-title">
            <p id="lib-share-risk-title" className="share-risk-title">
              Public link risk
            </p>
            <p className="share-risk-copy">
              This mints a temporary public URL on your host gateway. Anyone with the link can view the shared papers
              (and PDFs / notes if you allow them). OpenLeaf is <strong>not responsible</strong> for misuse of links you
              create.
            </p>
            <label className="share-check share-risk-ack">
              <input
                type="checkbox"
                checked={riskAck}
                onChange={(e) => setRiskAck(e.target.checked)}
                disabled={busy}
              />
              <span>
                I understand the risks and that OpenLeaf is <strong>not responsible</strong> for misuse of this link.
              </span>
            </label>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !riskAck || !canCreate}
            onClick={() => void onCreate()}
          >
            {busy ? "Creating…" : "Create share link"}
          </button>

          {lastInvite ? (
            <div className="share-cred" style={{ marginTop: 12 }}>
              <span className="share-cred-label">Invite URL</span>
              <code className="share-cred-value share-url">{lastInvite}</code>
              <button type="button" className="btn btn-quiet share-copy" onClick={() => void onCopy(lastInvite)}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          ) : null}
        </div>

        <div className="share-section">
          <p className="share-section-title">
            Active shares <span className="share-muted">({shares.length})</span>
          </p>
          {!shares.length ? (
            <p className="share-muted">No live paper shares.</p>
          ) : (
            <ul className="library-share-list">
              {shares.map((s) => (
                <li key={s.id} className="library-share-item">
                  <div>
                    <strong>{s.settings.title}</strong>
                    <div className="share-muted">
                      {s.paperCount} paper{s.paperCount === 1 ? "" : "s"} · {s.visitors.length} guest
                      {s.visitors.length === 1 ? "" : "s"} · {s.noteCount} note
                      {s.noteCount === 1 ? "" : "s"} · {s.settings.role}
                    </div>
                    <code className="share-cred-value share-url">{s.inviteUrl}</code>
                  </div>
                  <div className="share-row-actions">
                    <button type="button" className="btn btn-quiet" onClick={() => void onCopy(s.inviteUrl)}>
                      Copy
                    </button>
                    <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void onStop(s.id)}>
                      Stop
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="share-section">
          <p className="share-section-title">Add from a share</p>
          <p className="share-muted">Paste an OpenLeaf paper-share URL or a downloaded JSON bundle.</p>
          <textarea
            className="library-share-input"
            rows={3}
            value={importUrl}
            onChange={(e) => setImportUrl(e.target.value)}
            placeholder="https://…/lib-share/… or {…}"
            disabled={busy}
          />
          <button type="button" className="btn btn-quiet" disabled={busy || !importUrl.trim()} onClick={() => void onImport()}>
            Import into library
          </button>
          {importResult ? <p className="share-muted">{importResult}</p> : null}
        </div>
      </div>
    </div>
  );
}
