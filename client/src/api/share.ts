export type ShareSettings = {
  /** null = no automatic expiry. */
  expiresAt: number | null;
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

export type ShareAiCollaboratorView = {
  id: string;
  slug: string;
  branchId: string;
  branchName: string;
  parentBranchId: string;
  parentBranchName: string;
  parentTipHash: string;
  token: string | null;
  aiUrl: string | null;
  starterPrompt?: string | null;
  createdAt: number;
  expiresAt: number | null;
  revoked: boolean;
  compileCount: number;
  writeCount: number;
};

export type ShareSessionView = {
  id: string;
  projectId: string;
  branchId: string;
  branchName: string;
  status: "starting" | "active" | "stopped" | "error";
  error?: string;
  /** Bare tunnel origin (Cloudflare-assigned hostname). */
  url: string;
  /** What to send to guests: tunnel origin + themed /join/<token> path. */
  inviteUrl: string;
  hostname: string;
  /** False until trycloudflare.com DNS is publicly resolvable. */
  dnsReady: boolean;
  username: string;
  password: string;
  createdAt: number;
  settings: ShareSettings;
  ipsUsed: number;
  ips: ShareDevice[];
  /** Addresses refused because the device cap was full. */
  rejectedIps: number;
  guests: ShareGuest[];
  logTail: string[];
  events: ShareEvent[];
  aiCollaborators?: ShareAiCollaboratorView[];
};

export type ShareDevice = { ip: string; firstSeen: number; guests: string[]; blockedLogins: number };
export type ShareEvent = { at: number; text: string };

export type UpdateShareInput = {
  branchId?: string;
  expiresAt?: number | null;
  extendMinutes?: number;
  /** true → clear the deadline. */
  indefinite?: boolean;
  maxIps?: number;
  maxGuests?: number;
};

export type ShareStatusResponse = {
  active: boolean;
  session?: ShareSessionView;
  sessions?: ShareSessionView[];
};

export type StartShareInput = Partial<Omit<ShareSettings, "expiresAt">> & {
  branchId: string;
  allowMainShare?: boolean;
  expiresAt?: number | null;
  ttlMinutes?: number;
  indefinite?: boolean;
};

export type GuestShareInfo = {
  projectId: string;
  projectName?: string;
  branchId: string;
  branchName: string;
  expiresAt: number | null;
  readOnly: boolean;
  allowCompile: boolean;
  allowDownload: boolean;
  allowHistory: boolean;
};

export type GuestIdentity = { id: string; name: string; color: string };

export type GuestMe =
  | { mode: "host" }
  | { mode: "guest"; active: false; reason: "no-session" | "expired" }
  | { mode: "guest"; active: true; authenticated: false; linkOk: boolean; share: GuestShareInfo }
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

export function updateProjectShare(projectId: string, input: UpdateShareInput): Promise<ShareStatusResponse> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/share`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function stopProjectShare(
  projectId: string,
  branchId?: string,
): Promise<{ ok: boolean; stopped: boolean }> {
  const q = branchId ? `?branchId=${encodeURIComponent(branchId)}` : "";
  return request(`/api/projects/${encodeURIComponent(projectId)}/share${q}`, { method: "DELETE" });
}

export function revokeShareGuest(
  projectId: string,
  guestId: string,
  branchId?: string,
): Promise<{ ok: boolean }> {
  const q = branchId ? `?branchId=${encodeURIComponent(branchId)}` : "";
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/share/guests/${encodeURIComponent(guestId)}${q}`,
    { method: "DELETE" },
  );
}

export type MintAiCollaboratorResponse = {
  ok: boolean;
  ai: ShareAiCollaboratorView & { token: string };
  aiUrl: string;
  starterPrompt: string;
  session: ShareSessionView;
  sessions: ShareSessionView[];
};

export function mintAiCollaborator(
  projectId: string,
  input: { branchId: string; slug: string; ttlMinutes?: number | null },
): Promise<MintAiCollaboratorResponse> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/share/ai`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function revokeAiCollaborator(
  projectId: string,
  aiId: string,
  branchId: string,
): Promise<{ ok: boolean; session?: ShareSessionView; sessions: ShareSessionView[] }> {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/share/ai/${encodeURIComponent(aiId)}?branchId=${encodeURIComponent(branchId)}`,
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
