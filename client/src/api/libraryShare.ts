/** Host + guest API for paper / collection sharing (Paperpile-style private links). */

export type LibraryShareRole = "viewer" | "commenter";

export type LibraryShareSettings = {
  expiresAt: number | null;
  role: LibraryShareRole;
  allowPdf: boolean;
  allowExport: boolean;
  maxGuests: number;
  title: string;
};

export type SharedAuthor = { given: string; family: string };

export type SharedPaperView = {
  citekey: string;
  title: string;
  authors: SharedAuthor[];
  year: number | null;
  venue: string;
  doi: string | null;
  arxivId: string | null;
  url: string | null;
  abstract: string;
  tags: string[];
  starred: boolean;
  status: string;
  rating: number;
  hasPdf: boolean;
};

export type SharedNoteView = {
  id: string;
  citekey: string;
  authorName: string;
  authorColor: string;
  body: string;
  createdAt: number;
};

export type LibraryShareVisitorView = {
  id: string;
  name: string;
  color: string;
  joinedAt: number;
  lastSeen: number;
};

export type LibraryShareHostView = {
  id: string;
  token: string;
  status: string;
  createdAt: number;
  settings: LibraryShareSettings;
  collectionId: string | null;
  inviteUrl: string;
  paperCount: number;
  papers: Array<{ citekey: string; title: string; year: number | null }>;
  noteCount: number;
  visitors: LibraryShareVisitorView[];
};

export type LibraryShareGuestView = {
  id: string;
  title: string;
  role: LibraryShareRole;
  allowPdf: boolean;
  allowExport: boolean;
  expiresAt: number | null;
  papers: SharedPaperView[];
  notes: SharedNoteView[];
  visitor: { id: string; name: string; color: string } | null;
};

export type LibraryShareBundle = {
  kind: "openleaf-library-share";
  version: number;
  title: string;
  exportedAt: string;
  papers: Array<{
    citekey: string;
    title: string;
    authors: SharedAuthor[];
    year: number | null;
    venue: string;
    doi: string | null;
    arxivId: string | null;
    url: string | null;
    abstract: string;
    tags: string[];
  }>;
};

export type CreateLibraryShareInput = {
  citekeys?: string[];
  collectionId?: string | null;
  settings?: Partial<LibraryShareSettings>;
  riskAck: boolean;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: "include",
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
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/* —— Host —— */

export function listLibraryShares(): Promise<{ shares: LibraryShareHostView[] }> {
  return request("/api/library-share");
}

export function createLibraryShare(
  input: CreateLibraryShareInput,
): Promise<{ share: LibraryShareHostView; inviteUrl: string }> {
  return request("/api/library-share", { method: "POST", body: JSON.stringify(input) });
}

export function stopLibraryShare(id: string): Promise<void> {
  return request(`/api/library-share/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function importLibraryShare(input: {
  token?: string;
  inviteUrl?: string;
  bundle?: LibraryShareBundle;
}): Promise<{
  imported: string[];
  skipped: Array<{ title: string; reason: string; existingCitekey?: string }>;
  count: number;
}> {
  return request("/api/library-share/import", { method: "POST", body: JSON.stringify(input) });
}

/* —— Guest (token is the credential) —— */

export function getLibraryShareGuest(
  token: string,
  visitorId?: string,
): Promise<{ share: LibraryShareGuestView }> {
  const q = visitorId ? `?visitorId=${encodeURIComponent(visitorId)}` : "";
  return request(`/api/lib-share/${encodeURIComponent(token)}${q}`);
}

export function joinLibraryShare(
  token: string,
  input: { visitorId?: string; name?: string },
): Promise<{ visitor: { id: string; name: string; color: string }; share: LibraryShareGuestView }> {
  return request(`/api/lib-share/${encodeURIComponent(token)}/join`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function postLibraryShareNote(
  token: string,
  input: { citekey: string; body: string; visitorId?: string; authorName?: string },
): Promise<{ note: SharedNoteView; share: LibraryShareGuestView }> {
  return request(`/api/lib-share/${encodeURIComponent(token)}/notes`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function fetchLibraryShareBundle(token: string): Promise<LibraryShareBundle> {
  return request(`/api/lib-share/${encodeURIComponent(token)}/bundle`);
}

export function librarySharePdfUrl(token: string, citekey: string): string {
  return `/api/lib-share/${encodeURIComponent(token)}/pdf/${encodeURIComponent(citekey)}`;
}
