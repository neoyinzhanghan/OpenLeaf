import { useState, type FormEvent } from "react";
import { hostLogin } from "../api/share";
import { ThemePicker } from "../components/ThemeToggle";
import { useSession } from "../session/SessionContext";

export function HostLogin() {
  const { refresh } = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await hostLogin({ username, password });
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
        <div className="guest-wordmark">
          <img className="toolbar-logo" src="/logo.png" alt="" />
          <span className="brand-mark">OpenLeaf</span>
        </div>
        <ThemePicker compact />
      </div>
      <form className="guest-card" onSubmit={(e) => void onSubmit(e)}>
        <p className="guest-kicker">Host access</p>
        <h1>Sign in to OpenLeaf</h1>
        <p className="guest-lead">
          This is the public link to the editor running on your machine. Enter the host password to
          open projects from this phone or another computer.
        </p>

        <label className="guest-field">
          <span>Username</span>
          <input
            autoComplete="username"
            spellCheck={false}
            placeholder="Host username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label className="guest-field">
          <span>Password</span>
          <div className="guest-password-row">
            <input
              autoFocus
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button
              type="button"
              className="btn btn-ghost guest-password-toggle"
              onClick={() => setShowPassword((v) => !v)}
              aria-pressed={showPassword}
              aria-label={showPassword ? "Hide password" : "Show password"}
              title={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </label>

        {error && <div className="error-banner guest-error">{error}</div>}

        <button type="submit" className="btn btn-primary guest-submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
