import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { guestMe, type GuestIdentity, type GuestMe, type GuestShareInfo } from "../api/share";

/**
 * Who is using this browser tab: the machine owner (host, full UI) or a guest
 * who arrived through a share link (confined to one project). Resolved once
 * from /api/guest/me and refreshed after sign-in / sign-out.
 */
export type Session =
  | { kind: "loading" }
  | { kind: "host" }
  | { kind: "guest-inactive"; reason: "no-session" | "expired" }
  | { kind: "guest-login"; share: GuestShareInfo }
  | { kind: "guest"; share: GuestShareInfo; guest: GuestIdentity };

type Ctx = { session: Session; refresh: () => Promise<void> };

const SessionCtx = createContext<Ctx>({ session: { kind: "loading" }, refresh: async () => {} });

function fromMe(me: GuestMe): Session {
  if (me.mode === "host") return { kind: "host" };
  if (!me.active) return { kind: "guest-inactive", reason: me.reason };
  if (!me.authenticated) return { kind: "guest-login", share: me.share };
  return { kind: "guest", share: me.share, guest: me.guest };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({ kind: "loading" });

  const refresh = useCallback(async () => {
    try {
      setSession(fromMe(await guestMe()));
    } catch {
      // Server unreachable or ancient server without the endpoint: behave as before.
      setSession({ kind: "host" });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Guests: poll so an expired / ended session drops them back to a clear message.
  useEffect(() => {
    if (session.kind !== "guest") return;
    const t = window.setInterval(() => void refresh(), 20_000);
    return () => window.clearInterval(t);
  }, [session.kind, refresh]);

  const value = useMemo(() => ({ session, refresh }), [session, refresh]);
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSession(): Ctx {
  return useContext(SessionCtx);
}

/** Convenience: guest-mode facts for the editor, or null for the host. */
export function useGuest(): { share: GuestShareInfo; guest: GuestIdentity } | null {
  const { session } = useSession();
  return session.kind === "guest" ? { share: session.share, guest: session.guest } : null;
}
