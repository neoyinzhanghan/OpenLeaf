import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { checkoutProjectTimeline, getProjectTimeline } from "../api/client";
import type { TimelineView } from "../api/types";
import {
  listProjectAiLinks,
  mintAiCollaborator,
  revokeAiCollaborator,
  type AiGatewayView,
  type ShareAiCollaboratorView,
} from "../api/share";
import { ErrorBanner } from "./ErrorBanner";
import { isAiBranch } from "./timelineLayout";
import { copyText } from "../lib/clipboard";

type Props = {
  projectId: string;
  open: boolean;
  onClose: () => void;
  /** Human leaf currently open in the editor (hosts). Guests mint from their bound leaf instead. */
  branchId: string;
  branchName: string;
  /** Guest share binding; when set, mint/list/revoke are scoped to this leaf. */
  guestBoundBranchId?: string | null;
  guestBoundBranchName?: string | null;
  guestId?: string | null;
  canEditLeaf: boolean;
  onTimelineChange?: (view: TimelineView) => void;
  onOpenAiReview?: () => void;
  onCountChange?: (liveCount: number) => void;
};

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

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

export function AiLinkPanel({
  projectId,
  open,
  onClose,
  branchId,
  branchName,
  guestBoundBranchId = null,
  guestBoundBranchName = null,
  guestId = null,
  canEditLeaf,
  onTimelineChange,
  onOpenAiReview,
  onCountChange,
}: Props) {
  const isGuest = Boolean(guestBoundBranchId);
  const parentBranchId = guestBoundBranchId || branchId;
  const parentBranchName = guestBoundBranchName || branchName;
  const parentIsAi = isAiBranch({ id: parentBranchId, name: parentBranchName });

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collaborators, setCollaborators] = useState<ShareAiCollaboratorView[]>([]);
  const [gateway, setGateway] = useState<AiGatewayView | null>(null);
  const [slug, setSlug] = useState("chatgpt-pass1");
  const [ttlMinutes, setTtlMinutes] = useState<number | "">("");
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const [lastMcpConfig, setLastMcpConfig] = useState<string | null>(null);
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const [lastId, setLastId] = useState<string | null>(null);
  const [riskAck, setRiskAck] = useState(false);

  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;

  const applyList = useCallback(
    (data: { gateway: AiGatewayView; collaborators: ShareAiCollaboratorView[] }) => {
      setGateway(data.gateway);
      setCollaborators(data.collaborators.filter((a) => !a.revoked));
      onCountChangeRef.current?.(data.collaborators.filter((a) => !a.revoked).length);
    },
    [],
  );

  const refresh = useCallback(async () => {
    const data = await listProjectAiLinks(projectId, isGuest ? parentBranchId : undefined);
    applyList(data);
  }, [projectId, isGuest, parentBranchId, applyList]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setRiskAck(false);
    void refresh()
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load AI links"))
      .finally(() => setLoading(false));
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => void refresh().catch(() => undefined), 5000);
    return () => window.clearInterval(t);
  }, [open, refresh]);

  // Keep the toolbar badge accurate even when the drawer is closed.
  useEffect(() => {
    void refresh().catch(() => undefined);
    const t = window.setInterval(() => void refresh().catch(() => undefined), 20_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const onThisLeaf = collaborators.filter((a) => a.parentBranchId === parentBranchId);
  const onOtherLeaves = isGuest ? [] : collaborators.filter((a) => a.parentBranchId !== parentBranchId);
  const canMint = !parentIsAi && (isGuest || canEditLeaf);

  const onMint = async () => {
    const nextSlug = slug.trim();
    if (!nextSlug) {
      setError("Pick a short slug for the AI sandbox (e.g. chatgpt-pass1)");
      return;
    }
    if (!riskAck) {
      setError("Confirm the public AI-link risk acknowledgment before minting");
      return;
    }
    if (!canMint) {
      setError(
        parentIsAi
          ? "AI links fork from a human leaf — switch off this sandbox first"
          : "Open this leaf’s live tip to mint an AI link",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await mintAiCollaborator(projectId, {
        branchId: parentBranchId,
        slug: nextSlug,
        ttlMinutes: ttlMinutes === "" ? null : Number(ttlMinutes),
      });
      applyList({ gateway: r.gateway, collaborators: r.collaborators });
      setLastPrompt(r.starterPrompt);
      setLastMcpConfig(r.mcpConfig);
      setLastUrl(r.aiUrl);
      setLastId(r.ai.id);
      try {
        onTimelineChange?.(await getProjectTimeline(projectId, guestBoundBranchId ?? undefined));
      } catch {
        /* timeline refresh optional */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not mint AI collaborator");
    } finally {
      setBusy(false);
    }
  };

  const onRevoke = async (aiId: string, name: string) => {
    if (!window.confirm(`Revoke AI link for “${name}”? The token stops working; the fork stays on the timeline.`)) {
      return;
    }
    try {
      const r = await revokeAiCollaborator(projectId, aiId);
      applyList(r);
      if (lastId === aiId) {
        setLastPrompt(null);
        setLastMcpConfig(null);
        setLastUrl(null);
        setLastId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke AI link");
    }
  };

  if (!open) return null;

  return (
    <aside className="history-drawer share-drawer ai-link-drawer" aria-label="AI links">
      <div className="history-drawer-head">
        <strong>AI links</strong>
        <div className="history-drawer-actions">
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} title="Close" aria-label="Close">
            ✕
          </button>
        </div>
      </div>

      {error ? (
        <ErrorBanner className="error-banner share-error" onDismiss={() => setError(null)}>
          {error}
        </ErrorBanner>
      ) : null}

      {loading && collaborators.length === 0 ? (
        <p className="history-hint">Loading…</p>
      ) : (
        <div className="share-body">
          <p className="history-hint">
            Independent of user share links. Each AI collaborator gets its own <code>ai/…</code> sandbox forked from
            the <strong>committed tip</strong> of a human leaf you can edit. You can mint several AIs on the same leaf;
            they never write the parent tip. Ending a user share does not revoke AI tokens. Cursor / Claude Desktop can
            attach via <strong>Copy MCP config</strong> (same token as the ChatGPT prompt).
          </p>

          <div className="share-section-title">
            Fork from
            <span className="share-muted">{parentBranchName}</span>
          </div>
          {parentIsAi ? (
            <p className="share-warn share-pad">
              You’re on an AI sandbox. Switch to a human leaf to mint another AI link from that leaf.
            </p>
          ) : !canEditLeaf && !isGuest ? (
            <p className="share-warn share-pad">Open this leaf’s live tip (not a historical checkpoint) to mint.</p>
          ) : (
            <p className="share-muted share-pad">
              Uncommitted WIP is not included — commit first if the model should see it. Multiple AI links on this leaf
              each get a unique sandbox branch.
            </p>
          )}

          {gateway && !gateway.localOnly && !gateway.dnsReady && (
            <div className="share-dns-wait" role="status">
              <strong>Hold on — the AI public hostname is still publishing.</strong>
              <span>You can mint now; wait for DNS before pasting the URL into an external model.</span>
            </div>
          )}
          {gateway?.localOnly && (
            <p className="share-muted share-pad">
              No public tunnel yet — AI tools use this machine ({gateway.url}). Install <code>cloudflared</code> for a
              public AI URL.
            </p>
          )}

          <div className="share-form share-ai-mint">
            <div className="share-field">
              <span className="share-field-label">Slug</span>
              <div className="share-inline">
                <input
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="chatgpt-pass1"
                  disabled={busy || !canMint}
                />
                <input
                  type="number"
                  min={1}
                  placeholder="TTL min (opt)"
                  value={ttlMinutes}
                  onChange={(e) => setTtlMinutes(e.target.value === "" ? "" : Number(e.target.value))}
                  disabled={busy || !canMint}
                  style={{ maxWidth: "7.5rem" }}
                />
              </div>
            </div>

            <div className="share-risk" role="group" aria-labelledby="ai-risk-title">
              <p id="ai-risk-title" className="share-risk-title">
                Public AI link risk
              </p>
              <p className="share-risk-copy">
                Minting publishes a bearer token (and usually a public tunnel URL) that can read and edit the AI sandbox
                you create. Treat that token like a password. OpenLeaf contributors are <strong>not responsible</strong>{" "}
                for the security or privacy of your manuscript, nor for what an external model or anyone with the token
                does. Only mint for tools and people you trust.
              </p>
              <label className="share-check share-risk-ack">
                <input
                  type="checkbox"
                  checked={riskAck}
                  onChange={(e) => setRiskAck(e.target.checked)}
                  disabled={busy || !canMint}
                />
                <span>
                  I understand the risks and that OpenLeaf is <strong>not responsible</strong> for the security of my
                  data or for misuse of this AI link.
                </span>
              </label>
            </div>

            <div className="share-footer">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !canMint || !riskAck}
                onClick={() => void onMint()}
              >
                {busy ? "Forking…" : "Mint AI link"}
              </button>
            </div>
          </div>

          {lastPrompt && lastUrl && (
            <div className="share-ai-fresh">
              <div className="share-cred">
                <span className="share-cred-label">AI URL</span>
                <code className="share-cred-value share-url" title={lastUrl}>
                  {lastUrl}
                </code>
                <CopyButton value={lastUrl} label="AI URL" />
              </div>
              <div className="share-cred">
                <span className="share-cred-label">Starter prompt</span>
                <CopyButton value={lastPrompt} label="self-contained prompt" primary>
                  Copy ChatGPT prompt
                </CopyButton>
              </div>
              {lastMcpConfig && (
                <div className="share-cred">
                  <span className="share-cred-label">MCP</span>
                  <CopyButton value={lastMcpConfig} label="MCP config">
                    Copy MCP config
                  </CopyButton>
                </div>
              )}
              <pre className="share-ai-prompt">{lastPrompt}</pre>
              {lastMcpConfig && <pre className="share-ai-prompt">{lastMcpConfig}</pre>}
            </div>
          )}

          <AiList
            title={`On this leaf (${onThisLeaf.length})`}
            items={onThisLeaf}
            projectId={projectId}
            canReview={!isGuest}
            canCheckout={!isGuest}
            canRevoke={(a) =>
              !isGuest || (a.mintedBy?.kind === "guest" && a.mintedBy.guestId === guestId)
            }
            onRevoke={onRevoke}
            onOpenReview={onOpenAiReview}
            onClose={onClose}
            onTimelineChange={onTimelineChange}
            onError={setError}
          />

          {onOtherLeaves.length > 0 && (
            <AiList
              title={`Other leaves (${onOtherLeaves.length})`}
              items={onOtherLeaves}
              projectId={projectId}
              canReview={!isGuest}
              canCheckout={!isGuest}
              canRevoke={(a) =>
                !isGuest || (a.mintedBy?.kind === "guest" && a.mintedBy.guestId === guestId)
              }
              onRevoke={onRevoke}
              onOpenReview={onOpenAiReview}
              onClose={onClose}
              onTimelineChange={onTimelineChange}
              onError={setError}
            />
          )}
        </div>
      )}
    </aside>
  );
}

function AiList({
  title,
  items,
  projectId,
  canReview,
  canCheckout,
  canRevoke,
  onRevoke,
  onOpenReview,
  onClose,
  onTimelineChange,
  onError,
}: {
  title: string;
  items: ShareAiCollaboratorView[];
  projectId: string;
  canReview: boolean;
  canCheckout: boolean;
  canRevoke: (a: ShareAiCollaboratorView) => boolean;
  onRevoke: (id: string, name: string) => void;
  onOpenReview?: () => void;
  onClose: () => void;
  onTimelineChange?: (view: TimelineView) => void;
  onError: (msg: string | null) => void;
}) {
  return (
    <>
      <div className="share-section-title">{title}</div>
      {items.length === 0 ? (
        <p className="share-muted share-pad">No live AI sandboxes on this leaf.</p>
      ) : (
        <ul className="share-guests share-ai-list">
          {items.map((a) => (
            <li key={a.id}>
              <span className="tl-chip ai">AI</span>
              <code title={a.branchName}>{a.branchName}</code>
              <span className="share-muted">
                from {a.parentBranchName} · {a.writeCount} writes · {a.compileCount} compiles
                {a.expiresAt ? ` · AI TTL ${formatWhen(a.expiresAt)}` : ""}
                {a.mintedBy?.kind === "guest" ? ` · by ${a.mintedBy.guestName}` : ""}
              </span>
              {a.aiUrl && <CopyButton value={a.aiUrl} label="AI URL" />}
              {a.starterPrompt && (
                <CopyButton value={a.starterPrompt} label="ChatGPT prompt">
                  Copy ChatGPT prompt
                </CopyButton>
              )}
              {a.mcpConfig && (
                <CopyButton value={a.mcpConfig} label="MCP config">
                  Copy MCP config
                </CopyButton>
              )}
              {canReview && onOpenReview && (
                <button
                  type="button"
                  className="btn btn-ghost share-copy"
                  onClick={() => {
                    onOpenReview();
                    onClose();
                  }}
                >
                  Review suggestions
                </button>
              )}
              {canCheckout && (
              <button
                type="button"
                className="btn btn-ghost share-copy"
                onClick={() => {
                  void (async () => {
                    try {
                      const view = await checkoutProjectTimeline(projectId, { branchId: a.branchId, nodeId: null });
                      onTimelineChange?.(view);
                    } catch (err) {
                      onError(err instanceof Error ? err.message : "Could not open AI branch");
                    }
                  })();
                }}
              >
                Open sandbox
              </button>
              )}
              {canRevoke(a) && (
              <button type="button" className="btn btn-ghost share-copy" onClick={() => void onRevoke(a.id, a.branchName)}>
                Revoke
              </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
