/** Host mint + helpers for library AI collaborator links. */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
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
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type LibraryAiSettings = {
  allowSearch: boolean;
  allowAdd: boolean;
  allowEnrich: boolean;
  maxAdds: number;
  title: string;
};

export type LibraryAiHostView = {
  id: string;
  createdAt: number;
  expiresAt: number | null;
  revoked: boolean;
  settings: LibraryAiSettings;
  addCount: number;
  verifyCount: number;
  libraryAiUrl: string | null;
  token: string | null;
  starterPrompt: string | null;
  mcpUrl: string | null;
  mcpConfig: string | null;
};

export function listLibraryAiLinks(): Promise<{ sessions: LibraryAiHostView[] }> {
  return request("/api/library-ai");
}

export function mintLibraryAiLink(body: {
  riskAck: true;
  ttlMinutes?: number | null;
  settings?: Partial<LibraryAiSettings>;
}): Promise<{
  session: LibraryAiHostView;
  libraryAiUrl: string;
  starterPrompt: string;
  mcpUrl: string;
  mcpConfig: string;
}> {
  return request("/api/library-ai", { method: "POST", body: JSON.stringify(body) });
}

export function revokeLibraryAiLink(id: string): Promise<void> {
  return request(`/api/library-ai/${encodeURIComponent(id)}`, { method: "DELETE" });
}
