/**
 * Paper / collection sharing — Paperpile-style private links + Zotero-ish notes.
 *
 * Sessions live in memory (like project Share). Invite URLs ride the host-gateway
 * (or localhost) as `/lib-share/<token>` so guests never need the host password;
 * possession of the token is the credential.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { getLibraryRootAbs } from "../config.js";
import { getHostGateway } from "./hostGateway.js";
import { getPaper, listAllRecords } from "./library/index.js";
import type { PaperRecord, ReadingStatus } from "./library/types.js";
import { paperDir } from "./library/paths.js";

export type LibraryShareRole = "viewer" | "commenter";

export type LibraryShareSettings = {
  expiresAt: number | null;
  /** viewer = read only; commenter = may leave shared notes */
  role: LibraryShareRole;
  allowPdf: boolean;
  allowExport: boolean;
  maxGuests: number;
  title: string;
};

export type SharedPaperSnapshot = {
  citekey: string;
  title: string;
  authors: PaperRecord["authors"];
  year: number | null;
  venue: string;
  doi: string | null;
  arxivId: string | null;
  url: string | null;
  abstract: string;
  tags: string[];
  starred: boolean;
  status: ReadingStatus;
  rating: number;
  notes: string;
  hasPdf: boolean;
};

export type SharedNote = {
  id: string;
  citekey: string;
  authorName: string;
  authorColor: string;
  body: string;
  createdAt: number;
};

export type LibraryShareVisitor = {
  id: string;
  name: string;
  color: string;
  joinedAt: number;
  lastSeen: number;
};

export type LibraryShareSession = {
  id: string;
  token: string;
  createdAt: number;
  settings: LibraryShareSettings;
  /** Project-collection id when sharing a whole collection; null for ad-hoc paper picks. */
  collectionId: string | null;
  papers: SharedPaperSnapshot[];
  notes: SharedNote[];
  visitors: Map<string, LibraryShareVisitor>;
  status: "active" | "stopped";
  expiryTimer: NodeJS.Timeout | null;
};

export type LibraryShareError = Error & { status: number };

function err(status: number, message: string): LibraryShareError {
  return Object.assign(new Error(message), { status });
}

const sessionsByToken = new Map<string, LibraryShareSession>();
const sessionsById = new Map<string, LibraryShareSession>();

const COLORS = ["#EF4444", "#F97316", "#EAB308", "#22C55E", "#3B82F6", "#8B5CF6", "#EC4899", "#06B6D4"];

function pickColor(): string {
  return COLORS[crypto.randomInt(COLORS.length)]!;
}

function makeToken(): string {
  return crypto.randomBytes(18).toString("base64url");
}

function publicBaseUrl(port: number): string {
  const gw = getHostGateway();
  if (gw?.url && gw.status === "active") return gw.url.replace(/\/$/, "");
  return `http://127.0.0.1:${port}`;
}

async function snapshotPaper(citekey: string): Promise<SharedPaperSnapshot> {
  const paper = await getPaper(citekey);
  const pdfPath = path.join(paperDir(citekey), "attachment.pdf");
  const hasPdf = Boolean(paper.attachment) || fs.existsSync(pdfPath);
  return {
    citekey: paper.citekey,
    title: paper.title,
    authors: paper.authors,
    year: paper.year,
    venue: paper.venue,
    doi: paper.doi,
    arxivId: paper.arxivId,
    url: paper.url,
    abstract: paper.abstract,
    tags: paper.tags,
    starred: paper.starred,
    status: paper.status,
    rating: paper.rating,
    notes: paper.notes,
    hasPdf,
  };
}

function normalizeSettings(input: Partial<LibraryShareSettings> | undefined): LibraryShareSettings {
  const role = input?.role === "commenter" ? "commenter" : "viewer";
  let expiresAt = input?.expiresAt ?? Date.now() + 7 * 24 * 3600_000;
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt < Date.now())) {
    expiresAt = Date.now() + 7 * 24 * 3600_000;
  }
  const maxGuests = Math.min(1000, Math.max(1, Math.floor(input?.maxGuests ?? 50)));
  return {
    expiresAt,
    role,
    allowPdf: input?.allowPdf !== false,
    allowExport: input?.allowExport !== false,
    maxGuests,
    title: (input?.title ?? "Shared papers").trim() || "Shared papers",
  };
}

function armExpiry(s: LibraryShareSession): void {
  if (s.expiryTimer) clearTimeout(s.expiryTimer);
  if (s.settings.expiresAt == null) return;
  const delay = s.settings.expiresAt - Date.now();
  if (delay <= 0) {
    void stopLibraryShare(s.id);
    return;
  }
  s.expiryTimer = setTimeout(() => {
    void stopLibraryShare(s.id);
  }, delay);
}

export function isLibraryShareExpired(s: LibraryShareSession): boolean {
  return s.settings.expiresAt != null && Date.now() > s.settings.expiresAt;
}

export async function createLibraryShare(input: {
  citekeys?: string[];
  collectionId?: string | null;
  settings?: Partial<LibraryShareSettings>;
  port: number;
}): Promise<{ session: LibraryShareSession; inviteUrl: string }> {
  let citekeys = [...new Set((input.citekeys ?? []).map((k) => k.trim()).filter(Boolean))];
  if (input.collectionId) {
    const all = await listAllRecords();
    const fromColl = all.filter((p) => p.collections.includes(input.collectionId!)).map((p) => p.citekey);
    citekeys = [...new Set([...citekeys, ...fromColl])];
  }
  if (!citekeys.length) throw err(400, "Select at least one paper (or a non-empty collection)");

  const papers: SharedPaperSnapshot[] = [];
  for (const key of citekeys) {
    try {
      papers.push(await snapshotPaper(key));
    } catch {
      /* skip missing */
    }
  }
  if (!papers.length) throw err(404, "None of the selected papers were found in the library");

  const settings = normalizeSettings({
    ...input.settings,
    title:
      input.settings?.title ||
      (input.collectionId ? `Collection share` : papers.length === 1 ? papers[0]!.title : `${papers.length} papers`),
  });

  const id = crypto.randomBytes(8).toString("hex");
  const token = makeToken();
  const session: LibraryShareSession = {
    id,
    token,
    createdAt: Date.now(),
    settings,
    collectionId: input.collectionId ?? null,
    papers,
    notes: [],
    visitors: new Map(),
    status: "active",
    expiryTimer: null,
  };
  sessionsByToken.set(token, session);
  sessionsById.set(id, session);
  armExpiry(session);

  const inviteUrl = `${publicBaseUrl(input.port)}/lib-share/${token}`;
  console.log(`[library-share] created ${id} (${papers.length} papers) → ${inviteUrl}`);
  return { session, inviteUrl };
}

export function getLibraryShareByToken(token: string): LibraryShareSession | null {
  const s = sessionsByToken.get(token);
  if (!s || s.status !== "active") return null;
  if (isLibraryShareExpired(s)) {
    void stopLibraryShare(s.id);
    return null;
  }
  return s;
}

export function getLibraryShareById(id: string): LibraryShareSession | null {
  const s = sessionsById.get(id);
  if (!s || s.status !== "active") return null;
  if (isLibraryShareExpired(s)) {
    void stopLibraryShare(s.id);
    return null;
  }
  return s;
}

export function listLibraryShares(): LibraryShareSession[] {
  return [...sessionsById.values()].filter((s) => s.status === "active" && !isLibraryShareExpired(s));
}

export async function stopLibraryShare(id: string): Promise<void> {
  const s = sessionsById.get(id);
  if (!s) return;
  s.status = "stopped";
  if (s.expiryTimer) clearTimeout(s.expiryTimer);
  sessionsByToken.delete(s.token);
  sessionsById.delete(id);
  console.log(`[library-share] stopped ${id}`);
}

export function touchVisitor(
  session: LibraryShareSession,
  opts: { visitorId?: string; name?: string },
): LibraryShareVisitor {
  if (opts.visitorId && session.visitors.has(opts.visitorId)) {
    const v = session.visitors.get(opts.visitorId)!;
    v.lastSeen = Date.now();
    if (opts.name?.trim()) v.name = opts.name.trim().slice(0, 64);
    return v;
  }
  if (session.visitors.size >= session.settings.maxGuests) {
    throw err(403, "This share has reached its visitor limit");
  }
  const visitor: LibraryShareVisitor = {
    id: opts.visitorId || crypto.randomBytes(6).toString("hex"),
    name: (opts.name?.trim() || `Guest-${crypto.randomInt(100, 999)}`).slice(0, 64),
    color: pickColor(),
    joinedAt: Date.now(),
    lastSeen: Date.now(),
  };
  session.visitors.set(visitor.id, visitor);
  return visitor;
}

export function addSharedNote(
  session: LibraryShareSession,
  input: { citekey: string; authorName: string; authorColor?: string; body: string },
): SharedNote {
  if (session.settings.role !== "commenter") throw err(403, "This share is view-only");
  const body = input.body.trim();
  if (!body) throw err(400, "Note body is required");
  if (!session.papers.some((p) => p.citekey === input.citekey)) {
    throw err(404, "Paper is not part of this share");
  }
  const note: SharedNote = {
    id: crypto.randomBytes(6).toString("hex"),
    citekey: input.citekey,
    authorName: (input.authorName || "Anonymous").trim().slice(0, 64),
    authorColor: input.authorColor || pickColor(),
    body: body.slice(0, 8000),
    createdAt: Date.now(),
  };
  session.notes.push(note);
  return note;
}

export function libraryShareHostView(s: LibraryShareSession, port: number) {
  return {
    id: s.id,
    token: s.token,
    status: s.status,
    createdAt: s.createdAt,
    settings: s.settings,
    collectionId: s.collectionId,
    inviteUrl: `${publicBaseUrl(port)}/lib-share/${s.token}`,
    paperCount: s.papers.length,
    papers: s.papers.map((p) => ({ citekey: p.citekey, title: p.title, year: p.year })),
    noteCount: s.notes.length,
    visitors: [...s.visitors.values()],
  };
}

export function libraryShareGuestView(s: LibraryShareSession, visitor: LibraryShareVisitor | null) {
  return {
    id: s.id,
    title: s.settings.title,
    role: s.settings.role,
    allowPdf: s.settings.allowPdf,
    allowExport: s.settings.allowExport,
    expiresAt: s.settings.expiresAt,
    papers: s.papers.map((p) => ({
      ...p,
      // Host private notes stay host-only unless empty; shared notes are separate.
      hostNotes: undefined,
      notes: undefined,
    })),
    notes: s.notes,
    visitor: visitor
      ? { id: visitor.id, name: visitor.name, color: visitor.color }
      : null,
  };
}

/** Bundle a share for import into another OpenLeaf library (JSON). */
export function libraryShareBundle(s: LibraryShareSession) {
  return {
    kind: "openleaf-library-share" as const,
    version: 1,
    title: s.settings.title,
    exportedAt: new Date().toISOString(),
    papers: s.papers.map((p) => ({
      citekey: p.citekey,
      title: p.title,
      authors: p.authors,
      year: p.year,
      venue: p.venue,
      doi: p.doi,
      arxivId: p.arxivId,
      url: p.url,
      abstract: p.abstract,
      tags: p.tags,
    })),
  };
}

export async function readSharedPdf(session: LibraryShareSession, citekey: string): Promise<Buffer | null> {
  if (!session.settings.allowPdf) throw err(403, "PDF sharing is disabled");
  if (!session.papers.some((p) => p.citekey === citekey && p.hasPdf)) return null;
  const candidates = [
    path.join(paperDir(citekey), "attachment.pdf"),
    path.join(getLibraryRootAbs(), "papers", citekey, "attachment.pdf"),
  ];
  for (const file of candidates) {
    try {
      return await fsPromises.readFile(file);
    } catch {
      /* try next */
    }
  }
  return null;
}
