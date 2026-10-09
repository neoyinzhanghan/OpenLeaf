/**
 * OpenReview forum / pdf notes.
 * A note the API actually returns is a public identifier, even with no DOI or arXiv id.
 */
import type { ResolvedAuthor, ResolvedPaper } from "./types.js";

const NOTE_ID = /^[A-Za-z0-9_.~-]{4,80}$/;

export function openReviewNoteIdFromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  if (host !== "openreview.net") return null;
  const path = url.pathname.replace(/\/+$/, "").toLowerCase();
  if (path !== "/forum" && path !== "/pdf") return null;
  const id = url.searchParams.get("id")?.trim() ?? "";
  if (!NOTE_ID.test(id)) return null;
  return id;
}

function contentField(content: Record<string, unknown>, key: string): unknown {
  const raw = content[key];
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "value" in raw) {
    return (raw as { value: unknown }).value;
  }
  return raw;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function asStrings(value: unknown): string[] {
  if (typeof value === "string") {
    const one = asString(value);
    return one ? [one] : [];
  }
  if (!Array.isArray(value)) return [];
  return value.map(asString).filter(Boolean);
}

function splitAuthor(name: string): ResolvedAuthor {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return { given: "", family: parts[0] || "Unknown" };
  return { given: parts.slice(0, -1).join(" "), family: parts[parts.length - 1]! };
}

function yearFrom(venue: string, cdate: unknown): number | null {
  const fromVenue = venue.match(/\b(?:19|20)\d{2}\b/);
  if (fromVenue) return Number(fromVenue[0]);
  if (typeof cdate === "number" && Number.isFinite(cdate) && cdate > 0) {
    const year = new Date(cdate).getUTCFullYear();
    if (year >= 1900 && year <= 2100) return year;
  }
  return null;
}

function doiFrom(content: Record<string, unknown>): string | null {
  const raw = asString(contentField(content, "doi")).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  return /^10\.\d{4,}\/\S+$/i.test(raw) ? raw : null;
}

export type OpenReviewLookup =
  | { ok: true; paper: ResolvedPaper }
  | { ok: false; reason: "not-found"; noteId: string }
  | { ok: false; reason: "blocked"; noteId: string; status: number };

type NoteJson = {
  id?: string;
  cdate?: number;
  content?: Record<string, unknown>;
};

export function paperFromOpenReviewNote(note: NoteJson, noteId: string): ResolvedPaper | null {
  const content = note.content ?? {};
  const title = asString(contentField(content, "title"));
  if (!title) return null;
  const venue =
    asString(contentField(content, "venue")) || asString(contentField(content, "venueid"));
  const doi = doiFrom(content);
  const id = (note.id?.trim() || noteId).trim();
  return {
    doi,
    arxivId: null,
    url: `https://openreview.net/forum?id=${id}`,
    title,
    authors: asStrings(contentField(content, "authors")).map(splitAuthor),
    venue,
    year: yearFrom(venue, note.cdate),
    abstract: asString(contentField(content, "abstract")),
    source: doi ? "doi" : "manual",
  };
}

export async function lookupOpenReviewNote(
  noteId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenReviewLookup> {
  const endpoint = `https://api2.openreview.net/notes?id=${encodeURIComponent(noteId)}`;
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      headers: {
        Accept: "application/json",
        "User-Agent": "OpenLeaf/1.0 (mailto:openleaf@localhost)",
      },
    });
  } catch {
    return { ok: false, reason: "blocked", noteId, status: 0 };
  }
  if (res.status === 404) return { ok: false, reason: "not-found", noteId };
  if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
    return { ok: false, reason: "blocked", noteId, status: res.status };
  }
  if (!res.ok) return { ok: false, reason: "not-found", noteId };
  let body: { notes?: NoteJson[] };
  try {
    body = (await res.json()) as { notes?: NoteJson[] };
  } catch {
    return { ok: false, reason: "not-found", noteId };
  }
  const notes = Array.isArray(body.notes) ? body.notes : [];
  const note = notes.find((n) => n.id === noteId) ?? notes[0];
  if (!note) return { ok: false, reason: "not-found", noteId };
  const paper = paperFromOpenReviewNote(note, noteId);
  if (!paper) return { ok: false, reason: "not-found", noteId };
  return { ok: true, paper };
}
