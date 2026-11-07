import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ErrorBanner } from "./ErrorBanner";
import {
  listLibraryAiLinks,
  mintLibraryAiLink,
  revokeLibraryAiLink,
  type LibraryAiHostView,
} from "../api/libraryAi";
import { copyText } from "../lib/clipboard";

const TTL_PRESETS: Array<{ label: string; minutes: number | null }> = [
  { label: "1 hour", minutes: 60 },
  { label: "1 day", minutes: 24 * 60 },
  { label: "7 days", minutes: 7 * 24 * 60 },
  { label: "No expiry", minutes: null },
];

type Props = {
  open: boolean;
  onClose: () => void;
};

function CopyButton({
  value,
  label,
  primary = false,
  children,
}: {
  value: string;
  label: string;
  primary?: boolean;
  children?: ReactNode;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={primary ? "btn btn-primary share-copy-primary" : "btn btn-ghost share-copy"}
      title={`Copy ${label}`}
      onClick={() => {
        void copyText(value).then((ok) => {
          if (!ok) return;
          setDone(true);
          window.setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      {done ? "Copied ✓" : children ?? "Copy"}
    </button>
  );
}

export function LibraryAiLinkPanel({ open, onClose }: Props) {
  const [sessions, setSessions] = useState<LibraryAiHostView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [riskAck, setRiskAck] = useState(false);
  const [title, setTitle] = useState("Literature review");
  const [allowSearch, setAllowSearch] = useState(true);
  const [allowAdd, setAllowAdd] = useState(true);
  const [allowEnrich, setAllowEnrich] = useState(false);
  const [maxAdds, setMaxAdds] = useState(50);
  const [ttlMinutes, setTtlMinutes] = useState<number | null>(7 * 24 * 60);
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const [lastConnector, setLastConnector] = useState<{ url: string; authorization: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { sessions: list } = await listLibraryAiLinks();
      setSessions(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setRiskAck(false);
    void refresh();
    const t = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(t);
  }, [open, refresh]);

  if (!open) return null;

  const onMint = async () => {
    if (!riskAck) {
      setError("Confirm the risk acknowledgment — this link can write verified papers into your library");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const minted = await mintLibraryAiLink({
        riskAck: true,
        ttlMinutes,
        settings: {
          title: title.trim() || "Library AI",
          allowSearch,
          allowAdd,
          allowEnrich,
          maxAdds,
        },
      });
      setLastPrompt(minted.starterPrompt);
      setLastUrl(minted.libraryAiUrl);
      if (minted.mcpUrl && minted.session.token) {
        setLastConnector({
          url: minted.mcpUrl,
          authorization: `Bearer ${minted.session.token}`,
        });
      }
      setSessions((prev) => [minted.session, ...prev.filter((s) => s.id !== minted.session.id)]);
      setRiskAck(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onRevoke = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await revokeLibraryAiLink(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="history-drawer share-drawer library-share-drawer"
      role="dialog"
      aria-modal="true"
      aria-label="Library AI link"
    >
      <div className="share-body">
        <div className="share-cred" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <div>
            <p className="share-section-title" style={{ margin: 0 }}>
              Library AI link
            </p>
            <p className="share-muted" style={{ margin: "4px 0 0" }}>
              ChatGPT proposes verified papers → you Accept/Reject before they enter the library
            </p>
          </div>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <p className="muted library-hint">
          Paste the prompt into ChatGPT or Claude when that assistant can reach the public address. For Claude, add the connector after you create the link so Claude calls the library from its own cloud. Copy a fresh prompt after you create the link. Each add is checked online, then waits in your review queue until you Accept it.
        </p>

        {error ? <ErrorBanner className="error-banner share-error" onDismiss={() => setError(null)}>{error}</ErrorBanner> : null}

        <label className="library-field">
          Link title
          <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
        </label>

        <div className="library-share-toggles">
          <label>
            <input
              type="checkbox"
              checked={allowSearch}
              onChange={(e) => setAllowSearch(e.target.checked)}
              disabled={busy}
            />{" "}
            Allow search
          </label>
          <label>
            <input
              type="checkbox"
              checked={allowAdd}
              onChange={(e) => setAllowAdd(e.target.checked)}
              disabled={busy}
            />{" "}
            Allow verified adds
          </label>
          <label>
            <input
              type="checkbox"
              checked={allowEnrich}
              onChange={(e) => setAllowEnrich(e.target.checked)}
              disabled={busy}
            />{" "}
            Allow enrich existing
          </label>
        </div>

        <label className="library-field">
          Max adds
          <input
            type="number"
            min={1}
            max={500}
            value={maxAdds}
            onChange={(e) => setMaxAdds(Math.max(1, Number(e.target.value) || 1))}
            disabled={busy}
          />
        </label>

        <div className="library-share-ttl" role="group" aria-label="Expiry">
          {TTL_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className={`library-chip${ttlMinutes === p.minutes ? " is-active" : ""}`}
              onClick={() => setTtlMinutes(p.minutes)}
              disabled={busy}
            >
              {p.label}
            </button>
          ))}
        </div>

        <label className="library-share-risk share-check">
          <input
            type="checkbox"
            checked={riskAck}
            onChange={(e) => setRiskAck(e.target.checked)}
            disabled={busy}
          />
          <span>
            I understand this public link lets an external AI propose papers into a review queue (after
            online verification). Nothing enters the library until I Accept. I will revoke the link when
            done.
          </span>
        </label>

        <button type="button" className="btn btn-primary" disabled={busy || !riskAck} onClick={() => void onMint()}>
          Mint library AI link
        </button>

        {lastPrompt ? (
          <div className="library-share-invite">
            <p className="muted">Paste this into ChatGPT or Claude. Leave the briefing page unopened.</p>
            <div className="library-share-invite-actions">
              <CopyButton value={lastPrompt} label="prompt" primary>
                Copy prompt
              </CopyButton>
              {lastUrl ? <CopyButton value={lastUrl} label="briefing URL" /> : null}
            </div>
            <pre className="library-share-invite-url">{lastPrompt.slice(0, 420)}…</pre>
          </div>
        ) : null}

        {lastConnector || sessions.some((s) => s.mcpUrl && s.token) ? (
          <div className="library-connector">
            <h3>Claude connector</h3>
            <ol className="library-connector-steps">
              <li>In Claude, open Customize, then Connectors, then Add custom connector.</li>
              <li>Paste the connector URL.</li>
              <li>Choose No sign-in.</li>
              <li>
                Add a request header named Authorization. Paste the copied header value, including the word Bearer
                and the space after it. Claude shows request headers on accounts where that beta is enabled.
              </li>
              <li>Turn the connector on in the chat. Each add still waits in your review queue until you Accept.</li>
            </ol>
            {lastConnector ? (
              <>
                <div className="library-share-invite-actions">
                  <CopyButton value={lastConnector.url} label="connector URL" primary>
                    Copy connector URL
                  </CopyButton>
                  <CopyButton value={lastConnector.authorization} label="Authorization header">
                    Copy header
                  </CopyButton>
                </div>
                <pre className="library-connector-url">{lastConnector.url}</pre>
              </>
            ) : (
              <p className="muted">Copy the URL and header from a live link below.</p>
            )}
          </div>
        ) : null}

        <h3 className="library-share-subhead">Live links</h3>
        {!sessions.length ? <p className="muted">No active library AI links.</p> : null}
        <ul className="library-share-list">
          {sessions.map((s) => (
            <li key={s.id}>
              <div>
                <strong>{s.settings.title}</strong>
                <div className="muted">
                  adds {s.addCount}/{s.settings.maxAdds}
                  {s.expiresAt ? ` · expires ${new Date(s.expiresAt).toLocaleString()}` : " · no expiry"}
                </div>
              </div>
              <div className="library-share-list-actions">
                {s.starterPrompt ? (
                  <CopyButton value={s.starterPrompt} label="prompt">
                    Prompt
                  </CopyButton>
                ) : null}
                {s.mcpUrl ? (
                  <CopyButton value={s.mcpUrl} label="connector URL">
                    URL
                  </CopyButton>
                ) : null}
                {s.token ? (
                  <CopyButton value={`Bearer ${s.token}`} label="Authorization header">
                    Header
                  </CopyButton>
                ) : null}
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => void onRevoke(s.id)}
                >
                  Revoke
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
