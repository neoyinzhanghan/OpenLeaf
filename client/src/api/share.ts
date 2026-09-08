export type ShareSettings = {
  expiresAt: number;
  maxIps: number;
  maxGuests: number;
  readOnly: boolean;
  allowCompile: boolean;
  allowDownload: boolean;
  allowHistory: boolean;
};

export type ShareGuest = {
  id: string;
  name: string;
  color: string;
  ip: string;
  joinedAt: number;
  lastSeen: number;
  revoked: boolean;
};

export type ShareSessionView = {
  id: string;
  projectId: string;
  status: "starting" | "active" | "stopped" | "error";
  error?: string;
  url: string;
  hostname: string;
  username: string;
  password: string;
  createdAt: number;
  settings: ShareSettings;
  ipsUsed: number;
  guests: ShareGuest[];
  logTail: string[];
};

export type ShareStatusResponse = { active: boolean; session?: ShareSessionView };

export type StartShareInput = Partial<Omit<ShareSettings, "expiresAt">> & {
  expiresAt?: number;
  ttlMinutes?: number;
};

export type GuestShareInfo = {
  projectId: string;
  projectName?: string;
  expiresAt: number;
  readOnly: boolean;
  allowCompile: boolean;
  allowDownload: boolean;
  allowHistory: boolean;
};

export type GuestIdentity = { id: string; name: string; color: string };

export type GuestMe =
  | { mode: "host" }
  | { mode: "guest"; active: false; reason: "no-session" | "expired" }
  | { mode: "guest"; active: true; authenticated: false; share: GuestShareInfo }
  | { mode: "guest"; active: true; authenticated: true; share: GuestShareInfo; guest: GuestIdentity };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

/* Host side */

export function getProjectShare(projectId: string): Promise<ShareStatusResponse> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/share`);
}

export function startProjectShare(projectId: string, input: StartShareInput): Promise<ShareStatusResponse> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/share`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function stopProjectShare(projectId: string): Promise<{ ok: boolean; stopped: boolean }> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/share`, { method: "DELETE" });
}

export function revokeShareGuest(projectId: string, guestId: string): Promise<{ ok: boolean }> {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/share/guests/${encodeURIComponent(guestId)}`,
    { method: "DELETE" },
  );
}

export function listShares(): Promise<{
  cloudflared: { available: boolean; path?: string; error?: string };
  sessions: ShareSessionView[];
}> {
  return request("/api/share");
}

/* Guest side */

export function guestMe(): Promise<GuestMe> {
  return request("/api/guest/me");
}

export function guestLogin(body: {
  username: string;
  password: string;
  displayName: string;
}): Promise<{ ok: boolean; guest: GuestIdentity; share: GuestShareInfo }> {
  return request("/api/guest/login", { method: "POST", body: JSON.stringify(body) });
}

export function guestLogout(): Promise<{ ok: boolean }> {
  return request("/api/guest/logout", { method: "POST", body: "{}" });
}
