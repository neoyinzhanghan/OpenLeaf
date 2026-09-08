import { useState, type FormEvent } from "react";
import { guestLogin, type GuestShareInfo } from "../api/share";
import { ThemeToggle } from "../components/ThemeToggle";
import { useSession } from "../session/SessionContext";

function formatExpiry(ms: number | null): string {
  if (ms === null) return "No automatic expiry — the host ends the session";
  const d = new Date(ms);
  return `Access ends ${d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

export function GuestLogin({ share, linkOk }: { share: GuestShareInfo; linkOk: boolean }) {
  const { refresh } = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState(() => localStorage.getItem("openleaf.guestName") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await guestLogin({ username, password, displayName });
      localStorage.setItem("openleaf.guestName", displayName.trim());
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="guest-shell">
      <div className="guest-topbar">
        <img className="toolbar-logo" src="/logo.png" alt="OpenLeaf logo" />
        <ThemeToggle />
      </div>
      <form className="guest-card" onSubmit={(e) => void onSubmit(e)}>
        <p className="guest-kicker">Shared project</p>
        <h1>{share.projectName ?? share.projectId}</h1>
        <p className="guest-lead">
          The host has invited you to {share.readOnly ? "view" : "edit"} this document live. Enter the
          credentials they sent you and tell everyone who you are.
        </p>

        <label className="guest-field">
          <span>Username</span>
          <input
            autoFocus
            autoComplete="username"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="e.g. griffin-4821"
            required
          />
        </label>
        <label className="guest-field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <label className="guest-field">
          <span>Your name (shown to collaborators)</span>
          <input
            autoComplete="nickname"
            maxLength={40}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="How should we label your cursor?"
            required
          />
        </label>

        {!linkOk && (
          <div className="error-banner guest-error">
            This address is missing its invitation code. Open the <strong>complete link</strong> the host sent you
            (it ends in <code>/join/…</code>); the credentials alone are not enough.
          </div>
        )}
        {error && <div className="error-banner guest-error">{error}</div>}

        <button type="submit" className="btn btn-primary guest-submit" disabled={busy || !linkOk}>
          {busy ? "Signing in…" : "Join session"}
        </button>

        <ul className="guest-facts">
          <li>{formatExpiry(share.expiresAt)}</li>
          <li>{share.readOnly ? "Read-only: you can follow along but not edit" : "You can edit in real time with the host"}</li>
          {!share.allowDownload && <li>Downloads are disabled for this link</li>}
        </ul>
      </form>
    </div>
  );
}

export function GuestInactive({ reason }: { reason: "no-session" | "expired" }) {
  return (
    <div className="guest-shell">
      <div className="guest-topbar">
        <img className="toolbar-logo" src="/logo.png" alt="OpenLeaf logo" />
        <ThemeToggle />
      </div>
      <div className="guest-card">
        <p className="guest-kicker">Share link</p>
        <h1>{reason === "expired" ? "This link has expired" : "This link is no longer active"}</h1>
        <p className="guest-lead">
          {reason === "expired"
            ? "The host set an expiry on this session and it has passed."
            : "The host ended the session, or the link was for a session that no longer exists."}{" "}
          Ask the host for a fresh link; every new session gets a new address and new credentials.
        </p>
      </div>
    </div>
  );
}
