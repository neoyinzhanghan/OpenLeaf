import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { forkProjectTimeline, getFileAccess } from "../api/client";
import type { TimelineView } from "../api/types";
import {
  getProjectShare,
  revokeShareGuest,
  startProjectShare,
  stopProjectShare,
  updateProjectShare,
  type ShareSessionView,
  type UpdateShareInput,
} from "../api/share";
import { ShareBranchPicker, type ShareBranchChoice } from "./ShareBranchPicker";
import { copyText } from "../lib/clipboard";

export type ShareLiveInfo = {
  active: boolean;
  count: number;
  /** null = indefinite; undefined = no live session. */
  expiresAt: number | null | undefined;
};

type Props = {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onActiveChange?: (info: ShareLiveInfo) => void;
  /** Called when starting a share forks a new branch (host should switch to it). */
  onTimelineChange?: (view: TimelineView) => void;
  onManageFileAccess?: () => void;
};

const TTL_PRESETS: Array<{ label: string; minutes: number }> = [
  { label: "1 hour", minutes: 60 },
  { label: "4 hours", minutes: 240 },
  { label: "12 hours", minutes: 720 },
  { label: "24 hours", minutes: 1440 },
  { label: "3 days", minutes: 3 * 1440 },
  { label: "7 days", minutes: 7 * 1440 },
];

function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

const EXTEND_PRESETS = [
  { label: "15 min", minutes: 15 },
  { label: "1 h", minutes: 60 },
  { label: "4 h", minutes: 240 },
  { label: "1 day", minutes: 1440 },
];

function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${pad(h)}:${pad(m)}:${pad(sec)}`;
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function formatAgo(ms: number): string {
  if (ms < 15_000) return "now";
  return `${formatRemaining(ms)} ago`;
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function UsageMeter({
  label,
  hint,
  used,
  max,
  extra,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  used: number;
  max: number;
  extra?: string;
  disabled: boolean;
  onChange: (next: number) => void;
}) {
  const pct = Math.min(100, (used / Math.max(1, max)) * 100);
  const full = used >= max;
  return (
    <div className={`share-usage-row${full ? " is-full" : ""}`}>
      <div className="share-usage-head">
        <span className="share-field-label">{label}</span>
        <span className="share-usage-count">
          <strong>{used}</strong> / {max}
          {full && <span className="share-usage-full">limit reached</span>}
        </span>
      </div>
      <div className="share-meter">
        <div className="share-meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="share-usage-foot">
        <span className="share-muted">
          {hint}
          {extra ? ` · ${extra}` : ""}
        </span>
        <span className="share-stepper" aria-label={`Adjust ${label.toLowerCase()} limit`}>
          <button type="button" className="btn btn-ghost" disabled={disabled || max <= 1} onClick={() => onChange(max - 1)}>
            −
          </button>
          <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => onChange(max + 1)}>
            +
          </button>
          <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => onChange(max + 5)}>
            +5
          </button>
        </span>
      </div>
    </div>
  );
}

function selectAll(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** Zoom-style invitation: one message with everything a guest needs. */
function buildInvitation(s: ShareSessionView): string {
  const access = s.settings.readOnly ? "read-only (follow along)" : "read & write (edit live)";
  return [
    `You're invited to collaborate on "${s.projectId}" in OpenLeaf.`,
    "",
    "Open this link:",
    s.inviteUrl,
    "",
    "Sign in with",
    `  Username: ${s.username}`,
    `  Password: ${s.password}`,
    "",
    "Then enter your name so everyone can see who is editing.",
    s.settings.expiresAt === null
      ? `Access: ${access}. No automatic expiry — the host ends the session.`
      : `Access: ${access}. The link expires ${formatWhen(s.settings.expiresAt)}.`,
  ].join("\n");
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

export function SharePanel({
  projectId,
  open,
  onClose,
  onActiveChange,
  onTimelineChange,
  onManageFileAccess,
}: Props) {
  const [session, setSession] = useState<ShareSessionView | null>(null);
  const [sessions, setSessions] = useState<ShareSessionView[]>([]);
  const [creating, setCreating] = useState(false);
  const [branchChoice, setBranchChoice] = useState<ShareBranchChoice | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Settings form
  const [ttlMode, setTtlMode] = useState<"preset" | "custom" | "indefinite">("preset");
  const [ttlMinutes, setTtlMinutes] = useState(240);
  const [customExpiry, setCustomExpiry] = useState(() => toLocalInputValue(Date.now() + 24 * 3600_000));
  const [maxIps, setMaxIps] = useState(2);
  const [maxGuests, setMaxGuests] = useState(3);
  const [readOnly, setReadOnly] = useState(false);
  const [lockedForGuests, setLockedForGuests] = useState(0);
  const [allowCompile, setAllowCompile] = useState(true);
  const [allowDownload, setAllowDownload] = useState(true);
  const [allowHistory, setAllowHistory] = useState(true);
  const [riskAck, setRiskAck] = useState(false);
  const [showPassword, setShowPassword] = useState(true);
  const [adjusting, setAdjusting] = useState(false);
  const [showExtendPicker, setShowExtendPicker] = useState(false);
  const [extendTo, setExtendTo] = useState(() => toLocalInputValue(Date.now() + 24 * 3600_000));

  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = session?.id ?? null;

  const refresh = useCallback(async () => {
    try {
      const r = await getProjectShare(projectId);
      const list = r.sessions ?? (r.session ? [r.session] : []);
      setSessions(list);
      const preferred =
        branchChoice?.mode === "continue"
          ? list.find((x) => x.branchId === branchChoice.branchId)
          : undefined;
      const s = preferred ?? list.find((x) => x.id === sessionIdRef.current) ?? list[0] ?? null;
      setSession(s);
      if (list.length === 0) setCreating(true);
      onActiveChangeRef.current?.({
        active: list.length > 0,
        count: list.length,
        expiresAt: s ? s.settings.expiresAt : list[0]?.settings.expiresAt,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load share status");
    }
  }, [projectId, branchChoice]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getFileAccess(projectId)
      .then((view) => {
        if (!cancelled) setLockedForGuests(view.rules.length);
      })
      .catch(() => {
        if (!cancelled) setLockedForGuests(0);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    // Fresh create form: never pre-select a branch (including main).
    setBranchChoice(null);
    setCreating(false);
    setRiskAck(false);
    void refresh().finally(() => setLoading(false));
  }, [open, projectId]); // eslint-disable-line react-hooks/exhaustive-deps -- reset only when opening

  // Live clock: ticks whenever a session exists, even with the drawer closed, so
  // opening the panel never shows a stale remaining time. Deliberately does not
  // depend on `refresh` — that callback used to change every parent render and
  // tear this interval down before it could fire.
  const sessionId = session?.id;
  useEffect(() => {
    if (!sessionId) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [sessionId]);

  // Guest list / usage while the drawer is open.
  useEffect(() => {
    if (!open || !sessionId) return;
    const t = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(t);
  }, [open, sessionId, refresh]);

  // Keep the toolbar badge accurate even when the drawer is closed.
  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const expiresAtInput = useMemo((): number | null | typeof NaN => {
    if (ttlMode === "indefinite") return null;
    if (ttlMode === "preset") return Date.now() + ttlMinutes * 60_000;
    const t = new Date(customExpiry).getTime();
    return Number.isFinite(t) ? t : NaN;
  }, [ttlMode, ttlMinutes, customExpiry]);

  const onStart = async () => {
    if (!branchChoice) {
      setError("Pick a timeline leaf for this share link");
      return;
    }
    if (!riskAck) {
      setError("Confirm the public-link risk acknowledgment before creating a link");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (expiresAtInput !== null && !Number.isFinite(expiresAtInput)) throw new Error("Pick a valid expiry date");

      let branchId: string;
      let allowMainShare = false;
      if (branchChoice.mode === "continue") {
        branchId = branchChoice.branchId;
        allowMainShare = branchChoice.allowMainShare;
      } else {
        const forked = await forkProjectTimeline(projectId, {
          fromNodeId: branchChoice.fromNodeId,
          name: branchChoice.forkName,
        });
        branchId = forked.branch.id;
        onTimelineChange?.(forked.timeline);
        setBranchChoice({
          mode: "continue",
          branchId: forked.branch.id,
          branchName: forked.branch.name,
          sacred: false,
          tipNodeId: forked.branch.headNodeId ?? forked.timeline.headNode?.id ?? "",
          allowMainShare: false,
        });
      }

      const r = await startProjectShare(projectId, {
        branchId,
        allowMainShare,
        ...(expiresAtInput === null
          ? { indefinite: true }
          : { expiresAt: Math.round(expiresAtInput as number) }),
        maxIps,
        maxGuests,
        readOnly,
        allowCompile,
        allowDownload,
        allowHistory,
      });
      const list = r.sessions ?? (r.session ? [r.session] : []);
      setSession(r.session ?? null);
      setSessions(list);
      setCreating(false);
      onActiveChange?.({
        active: list.length > 0,
        count: list.length,
        expiresAt: r.session?.settings.expiresAt,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start share");
    } finally {
      setBusy(false);
    }
  };

  const onStop = async () => {
    if (!window.confirm("End this user share? The link and credentials stop working immediately for everyone on this leaf. AI links and other user links stay up.")) return;
    setBusy(true);
    setError(null);
    try {
      await stopProjectShare(projectId, session?.branchId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not stop share");
    } finally {
      setBusy(false);
    }
  };

  const onUpdate = async (patch: UpdateShareInput) => {
    setAdjusting(true);
    setError(null);
    try {
      const r = await updateProjectShare(projectId, { ...patch, branchId: session?.branchId });
      const list = r.sessions ?? (r.session ? [r.session] : []);
      setSession(r.session ?? null);
      setSessions(list);
      onActiveChange?.({
        active: list.length > 0,
        count: list.length,
        expiresAt: r.session?.settings.expiresAt,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update share");
    } finally {
      setAdjusting(false);
    }
  };

  const onRevoke = async (guestId: string, name: string) => {
    if (!window.confirm(`Kick "${name}"? They will need to sign in again (if the limits allow).`)) return;
    try {
      await revokeShareGuest(projectId, guestId, session?.branchId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke guest");
    }
  };

  if (!open) return null;

  const liveGuests = session ? session.guests.filter((g) => !g.revoked) : [];
  const showCreate = creating || !session;
  const inviteText = session && !showCreate ? buildInvitation(session) : "";
  const indefinite = Boolean(session && session.settings.expiresAt === null);
  const remaining = session && session.settings.expiresAt !== null ? session.settings.expiresAt - now : 0;
  const elapsedPct =
    session && session.settings.expiresAt !== null
      ? Math.min(100, Math.max(0, ((now - session.createdAt) / (session.settings.expiresAt - session.createdAt)) * 100))
      : 0;

  return (
    <aside className="history-drawer share-drawer" aria-label="Share project">
      <div className="history-drawer-head">
        <strong>User links</strong>
        <div className="history-drawer-actions">
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} title="Close" aria-label="Close">
            ✕
          </button>
        </div>
      </div>

      {error && (
        <div className="error-banner share-error">
          {error}
          <button type="button" className="btn btn-ghost" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {loading && !session && sessions.length === 0 ? (
        <p className="history-hint">Loading…</p>
      ) : (
        <>
          {sessions.length > 0 && (
            <div className="share-session-tabs" role="tablist" aria-label="Live user links">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={!showCreate && session?.id === s.id}
                  className={`share-session-tab${!showCreate && session?.id === s.id ? " is-active" : ""}`}
                  onClick={() => {
                    setSession(s);
                    setCreating(false);
                  }}
                >
                  {s.branchName}
                </button>
              ))}
              <button
                type="button"
                className={`share-session-tab share-session-tab-new${showCreate ? " is-active" : ""}`}
                onClick={() => {
                  setCreating(true);
                  setBranchChoice(null);
                  setRiskAck(false);
                }}
              >
                + New user link
              </button>
            </div>
          )}
      {!showCreate && session ? (
        <div className="share-body">
          <p className="history-hint">
            Live user share for leaf <strong>{session.branchName}</strong> through a Cloudflare tunnel. Only this
            project is reachable. One user link per leaf — other leaves can have their own at the same time. AI
            collaborators are minted separately (AI links) and keep working if you end this user share.
          </p>

          {!session.dnsReady && (
            <div className="share-dns-wait" role="status">
              <strong>Hold on — Cloudflare is still publishing this hostname.</strong>
              <span>
                Opening the link too early shows <code>ERR_NAME_NOT_RESOLVED</code>. This often takes 30–90 seconds.
                On Windows, a failed lookup can stick: wait for the green ready state below, or run{" "}
                <code>ipconfig /flushdns</code> in Command Prompt and retry.
              </span>
            </div>
          )}
          {session.dnsReady && (
            <div className="share-dns-ready" role="status">
              Public DNS is ready — safe to send the invitation.
            </div>
          )}

          <div className="share-invite">
            <div className="share-invite-head">
              <span className="share-field-label">Invitation</span>
              <button
                type="button"
                className="btn btn-ghost share-copy"
                onClick={() => setShowPassword((v) => !v)}
                title={showPassword ? "Mask the password on screen" : "Show the password"}
              >
                {showPassword ? "Hide password" : "Show password"}
              </button>
            </div>
            <pre className="share-invite-text" onClick={(e) => selectAll(e.currentTarget)}>
              {showPassword ? inviteText : inviteText.replace(session.password, "••••••••••••••••")}
            </pre>
            <CopyButton value={inviteText} label="invitation" primary>
              {session.dnsReady ? "Copy invitation" : "Copy anyway (DNS not ready)"}
            </CopyButton>
            <span className="share-muted">
              {session.dnsReady
                ? "Paste it into chat or email — it has the link, the username and the password (even when masked above)."
                : "Wait for “Public DNS is ready” before sending this to guests if you can — early opens fail DNS on their machine."}
            </span>
          </div>

          <details className="share-individual">
            <summary>Copy items individually</summary>
            <div className="share-cred">
              <span className="share-cred-label">Link</span>
              <code className="share-cred-value share-url" title={session.inviteUrl}>
                {session.inviteUrl}
              </code>
              <CopyButton value={session.inviteUrl} label="invitation link" />
            </div>
            <div className="share-cred">
              <span className="share-cred-label">Username</span>
              <code className="share-cred-value">{session.username}</code>
              <CopyButton value={session.username} label="username" />
            </div>
            <div className="share-cred">
              <span className="share-cred-label">Password</span>
              <code className="share-cred-value">{showPassword ? session.password : "••••••••••••••••"}</code>
              <CopyButton value={session.password} label="password" />
            </div>
          </details>

          <p className="share-muted share-pad">
            {lockedForGuests} {lockedForGuests === 1 ? "file" : "files"} locked for guests
            {onManageFileAccess && (
              <>
                {" "}
                ·{" "}
                <button type="button" className="btn btn-ghost share-chip" onClick={onManageFileAccess}>
                  Manage
                </button>
              </>
            )}
          </p>

          <div className="share-section-title">
            {indefinite ? "Session time" : "Time left"}
            <span className={`share-countdown${!indefinite && remaining < 5 * 60_000 ? " is-urgent" : ""}`}>
              {indefinite ? "∞" : formatCountdown(remaining)}
            </span>
          </div>
          <div className="share-timer">
            {!indefinite && (
              <div className="share-meter">
                <div className="share-meter-fill share-meter-time" style={{ width: `${elapsedPct}%` }} />
              </div>
            )}
            <div className="share-timer-row">
              <span className="share-muted">
                Opened {formatWhen(session.createdAt)}
                {indefinite
                  ? " · no automatic expiry"
                  : ` · ends ${formatWhen(session.settings.expiresAt as number)}`}
              </span>
            </div>
            <div className="share-extend">
              {indefinite ? (
                <>
                  <span className="share-muted">Set a deadline</span>
                  {EXTEND_PRESETS.map((p) => (
                    <button
                      key={p.minutes}
                      type="button"
                      className="btn btn-ghost share-chip"
                      disabled={adjusting}
                      onClick={() => void onUpdate({ extendMinutes: p.minutes })}
                    >
                      in {p.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="btn btn-ghost share-chip"
                    disabled={adjusting}
                    onClick={() => setShowExtendPicker((v) => !v)}
                  >
                    until…
                  </button>
                </>
              ) : (
                <>
                  <span className="share-muted">Extend</span>
                  {EXTEND_PRESETS.map((p) => (
                    <button
                      key={p.minutes}
                      type="button"
                      className="btn btn-ghost share-chip"
                      disabled={adjusting}
                      onClick={() => void onUpdate({ extendMinutes: p.minutes })}
                    >
                      +{p.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="btn btn-ghost share-chip"
                    disabled={adjusting}
                    onClick={() => setShowExtendPicker((v) => !v)}
                  >
                    until…
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost share-chip"
                    disabled={adjusting}
                    onClick={() => void onUpdate({ indefinite: true })}
                  >
                    Make indefinite
                  </button>
                </>
              )}
            </div>
            {showExtendPicker && (
              <div className="share-inline">
                <input type="datetime-local" value={extendTo} onChange={(e) => setExtendTo(e.target.value)} />
                <button
                  type="button"
                  className="btn btn-ghost share-chip"
                  disabled={adjusting}
                  onClick={() => {
                    const t = new Date(extendTo).getTime();
                    if (!Number.isFinite(t)) {
                      setError("Pick a valid date and time");
                      return;
                    }
                    void onUpdate({ expiresAt: Math.round(t) }).then(() => setShowExtendPicker(false));
                  }}
                >
                  Set deadline
                </button>
              </div>
            )}
          </div>

          <div className="share-section-title">Limits &amp; usage</div>
          <div className="share-usage">
            <UsageMeter
              label="Devices"
              hint="distinct IP addresses admitted"
              used={session.ipsUsed}
              max={session.settings.maxIps}
              extra={session.rejectedIps > 0 ? `${session.rejectedIps} turned away` : undefined}
              disabled={adjusting}
              onChange={(v) => void onUpdate({ maxIps: v })}
            />
            <UsageMeter
              label="Guests"
              hint="signed in right now"
              used={liveGuests.length}
              max={session.settings.maxGuests}
              extra={
                session.guests.length > liveGuests.length
                  ? `${session.guests.length} joined in total, ${session.guests.length - liveGuests.length} left or kicked`
                  : undefined
              }
              disabled={adjusting}
              onChange={(v) => void onUpdate({ maxGuests: v })}
            />
            <div className="share-muted share-usage-note">
              Changes apply instantly; the link and credentials stay the same. Lowering a limit below current usage
              only blocks newcomers.
            </div>
          </div>

          {session.ips.length > 0 && (
            <>
              <div className="share-section-title">Devices seen</div>
              <ul className="share-devices">
                {session.ips.map((d) => (
                  <li key={d.ip}>
                    <code>{d.ip}</code>
                    <span className="share-muted">
                      first seen {formatWhen(d.firstSeen)}
                      {d.guests.length > 0 ? ` · ${d.guests.join(", ")}` : " · no sign-in yet"}
                      {d.blockedLogins > 0 ? ` · ${d.blockedLogins} failed login${d.blockedLogins === 1 ? "" : "s"}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="share-section-title">
            Signed-in guests
            <span className="share-muted">
              {session.settings.readOnly ? "read-only" : "read & write"} ·{" "}
              {[
                session.settings.allowCompile ? "compile" : null,
                session.settings.allowDownload ? "download" : null,
                session.settings.allowHistory ? "history" : null,
              ]
                .filter(Boolean)
                .join(", ") || "no extras"}
            </span>
          </div>
          {liveGuests.length === 0 ? (
            <p className="share-muted share-pad">Nobody has joined yet.</p>
          ) : (
            <ul className="share-guests">
              {liveGuests.map((g) => (
                <li key={g.id}>
                  <span className="presence-chip" style={{ ["--presence" as string]: g.color }}>
                    {g.name}
                  </span>
                  <span className="share-muted">
                    {g.ip} · joined {formatWhen(g.joinedAt)} · active {formatAgo(now - g.lastSeen)}
                  </span>
                  <button type="button" className="btn btn-ghost share-copy" onClick={() => void onRevoke(g.id, g.name)}>
                    Kick
                  </button>
                </li>
              ))}
            </ul>
          )}

          <details className="share-individual">
            <summary>Activity ({session.events.length})</summary>
            <ul className="share-events">
              {session.events
                .slice()
                .reverse()
                .map((e, i) => (
                  <li key={`${e.at}-${i}`}>
                    <span className="share-muted">{formatClock(e.at)}</span> {e.text}
                  </li>
                ))}
            </ul>
          </details>

          <div className="share-footer">
            <button type="button" className="btn btn-danger" onClick={() => void onStop()} disabled={busy}>
              {busy ? "Ending…" : "End this user link"}
            </button>
          </div>
        </div>
      ) : (
        <div className="share-body">
          <p className="history-hint">
            Create a temporary public user link for this project. Guests sign in with one-off credentials. One user
            link per leaf —             mint extra links for other leaves while this one stays live. AI collaborators are separate
            (use <strong>AI links</strong>); they do not need a user share.
          </p>
          {sessions.length > 0 && (
            <p className="share-muted share-pad">
              Already live: {sessions.map((s) => s.branchName).join(", ")}. Pick a different leaf (or fork one).
            </p>
          )}

          <div className="share-form">
            <div className="share-field">
              <span className="share-field-label">Bound to branch</span>
              <ShareBranchPicker
                projectId={projectId}
                value={branchChoice}
                onChange={setBranchChoice}
                disabled={busy}
              />
              <span className="share-muted">
                Empty until you pick a leaf. Guests only edit/commit that branch’s tip. One user link per leaf; a leaf
                that already has a user link is rejected. Fork at share-time to desync from an existing leaf. AI
                sandboxes are minted from <strong>AI links</strong>, not here.
              </span>
            </div>
            <div className="share-field">
              <span className="share-field-label">Expires</span>
              <div className="share-inline">
                <select
                  value={ttlMode === "preset" ? String(ttlMinutes) : ttlMode}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "custom") setTtlMode("custom");
                    else if (v === "indefinite") setTtlMode("indefinite");
                    else {
                      setTtlMode("preset");
                      setTtlMinutes(Number(v));
                    }
                  }}
                >
                  {TTL_PRESETS.map((p) => (
                    <option key={p.minutes} value={p.minutes}>
                      in {p.label}
                    </option>
                  ))}
                  <option value="custom">custom date & time…</option>
                  <option value="indefinite">indefinite (no automatic expiry)</option>
                </select>
                {ttlMode === "custom" && (
                  <input type="datetime-local" value={customExpiry} onChange={(e) => setCustomExpiry(e.target.value)} />
                )}
              </div>
              <span className="share-muted">
                {ttlMode === "indefinite"
                  ? "Runs until you click End this user link"
                  : Number.isFinite(expiresAtInput)
                    ? `Ends ${formatWhen(expiresAtInput as number)}`
                    : "Pick a valid date"}
              </span>
            </div>

            <div className="share-field-grid">
              <label className="share-field">
                <span className="share-field-label">Max unique IPs</span>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={maxIps}
                  onChange={(e) => setMaxIps(Math.max(1, Number(e.target.value) || 1))}
                />
                <span className="share-muted">device addresses allowed to sign in</span>
              </label>
              <label className="share-field">
                <span className="share-field-label">Max guests</span>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={maxGuests}
                  onChange={(e) => setMaxGuests(Math.max(1, Number(e.target.value) || 1))}
                />
                <span className="share-muted">people signed in at once</span>
              </label>
            </div>

            <div className="share-field">
              <span className="share-field-label">Guest access</span>
              <div className="share-access">
                <label className={`share-access-option${!readOnly ? " is-selected" : ""}`}>
                  <input type="radio" name="share-access" checked={!readOnly} onChange={() => setReadOnly(false)} />
                  <span>
                    <strong>Read &amp; write</strong>
                    <span className="share-muted">
                      Guests edit the source live with you, add/rename/upload files and save. Their changes are committed
                      under their display name.
                    </span>
                  </span>
                </label>
                <label className={`share-access-option${readOnly ? " is-selected" : ""}`}>
                  <input type="radio" name="share-access" checked={readOnly} onChange={() => setReadOnly(true)} />
                  <span>
                    <strong>Read-only</strong>
                    <span className="share-muted">
                      Guests follow along and see your cursor, but every edit, upload or rename is rejected by the server.
                    </span>
                  </span>
                </label>
              </div>
            </div>

            <span className="share-field-label">Guests may also…</span>
            <label className="share-check">
              <input type="checkbox" checked={allowCompile} onChange={(e) => setAllowCompile(e.target.checked)} />
              <span>
                <strong>Allow compile</strong>
                <span className="share-muted"> — guests can trigger latexmk on this machine</span>
              </span>
            </label>
            <label className="share-check">
              <input type="checkbox" checked={allowDownload} onChange={(e) => setAllowDownload(e.target.checked)} />
              <span>
                <strong>Allow downloads</strong>
                <span className="share-muted"> — PDF and ZIP export</span>
              </span>
            </label>
            <label className="share-check">
              <input type="checkbox" checked={allowHistory} onChange={(e) => setAllowHistory(e.target.checked)} />
              <span>
                <strong>Show history</strong>
                <span className="share-muted"> — guests can browse snapshots (restore stays host-only)</span>
              </span>
            </label>

            <div className="share-risk" role="group" aria-labelledby="share-risk-title">
              <p id="share-risk-title" className="share-risk-title">
                Public link risk
              </p>
              <p className="share-risk-copy">
                This opens a temporary public URL on the internet. Anyone with the invitation and credentials can reach
                this project (and, if you allow compile, run LaTeX on <em>your</em> machine). OpenLeaf contributors are{" "}
                <strong>not responsible</strong> for the security, privacy, or integrity of your data, nor for anything
                guests or AI tools do with a link you create. Use only with people and tools you trust.
              </p>
              <label className="share-check share-risk-ack">
                <input
                  type="checkbox"
                  checked={riskAck}
                  onChange={(e) => setRiskAck(e.target.checked)}
                  disabled={busy}
                />
                <span>
                  I understand the risks and that OpenLeaf is <strong>not responsible</strong> for the security of my
                  data or for misuse of this public link.
                </span>
              </label>
            </div>
          </div>

          <div className="share-footer">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void onStart()}
              disabled={
                busy ||
                !riskAck ||
                !branchChoice ||
                (branchChoice.mode === "continue" &&
                  branchChoice.sacred &&
                  !branchChoice.allowMainShare)
              }
            >
              {busy
                ? branchChoice?.mode === "fork"
                  ? "Forking & opening tunnel…"
                  : "Opening tunnel…"
                : readOnly
                  ? "Create read-only link"
                  : "Create read & write link"}
            </button>
          </div>
          <p className="share-muted share-pad">
            Requires <code>cloudflared</code> on this machine. The user link lives only while OpenLeaf runs here and
            this session is active. AI links use their own tunnel and are not tied to this share.
          </p>
        </div>
      )}
        </>
      )}
    </aside>
  );
}
