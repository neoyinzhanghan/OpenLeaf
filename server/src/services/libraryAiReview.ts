/**
 * Pending library AI proposals — host Accept/Reject before papers enter the library.
 * Mirrors project AI review (in-memory, keyed by library AI session).
 */
import crypto from "node:crypto";
import type { ResolvedPaper } from "./library/sources/types.js";
import {
  addVerifiedPaper,
  type ProposalInput,
  type VerifyAccept,
} from "./library/verifyProposal.js";
import type { PaperRecord } from "./library/types.js";
import type { LibraryAiSession } from "./libraryAiShare.js";

export type PendingLibraryProposal = {
  id: string;
  sessionId: string;
  sessionTitle: string;
  proposedAt: number;
  proposal: ProposalInput;
  verify: VerifyAccept;
  resolved: ResolvedPaper;
};

export type LibraryProposalView = {
  id: string;
  sessionId: string;
  sessionTitle: string;
  proposedAt: number;
  title: string;
  authors: ResolvedPaper["authors"];
  year: number | null;
  venue: string;
  doi: string | null;
  arxivId: string | null;
  url: string | null;
  abstract: string;
  identifier: VerifyAccept["checks"]["identifier"];
  proposal: ProposalInput;
};

function err(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/** sessionId → proposals */
const pendingBySession = new Map<string, PendingLibraryProposal[]>();

function newId(): string {
  return `prop_${crypto.randomBytes(8).toString("hex")}`;
}

export function enqueueLibraryProposal(
  session: LibraryAiSession,
  proposal: ProposalInput,
  verify: VerifyAccept,
): PendingLibraryProposal {
  const item: PendingLibraryProposal = {
    id: newId(),
    sessionId: session.id,
    sessionTitle: session.settings.title,
    proposedAt: Date.now(),
    proposal,
    verify,
    resolved: verify.resolved,
  };
  const list = pendingBySession.get(session.id) ?? [];
  list.unshift(item);
  pendingBySession.set(session.id, list);
  return item;
}

export function listPendingLibraryProposals(sessionId?: string): PendingLibraryProposal[] {
  if (sessionId) return [...(pendingBySession.get(sessionId) ?? [])];
  const out: PendingLibraryProposal[] = [];
  for (const list of pendingBySession.values()) out.push(...list);
  out.sort((a, b) => b.proposedAt - a.proposedAt);
  return out;
}

export function pendingLibraryProposalCount(): number {
  let n = 0;
  for (const list of pendingBySession.values()) n += list.length;
  return n;
}

export function proposalView(p: PendingLibraryProposal): LibraryProposalView {
  const r = p.resolved;
  return {
    id: p.id,
    sessionId: p.sessionId,
    sessionTitle: p.sessionTitle,
    proposedAt: p.proposedAt,
    title: r.title,
    authors: r.authors,
    year: r.year,
    venue: r.venue,
    doi: r.doi,
    arxivId: r.arxivId,
    url: r.url,
    abstract: r.abstract,
    identifier: p.verify.checks.identifier,
    proposal: p.proposal,
  };
}

function takeProposal(id: string): PendingLibraryProposal | null {
  for (const [sessionId, list] of pendingBySession.entries()) {
    const idx = list.findIndex((p) => p.id === id);
    if (idx < 0) continue;
    const [item] = list.splice(idx, 1);
    if (!list.length) pendingBySession.delete(sessionId);
    else pendingBySession.set(sessionId, list);
    return item ?? null;
  }
  return null;
}

export function rejectLibraryProposal(id: string): boolean {
  return Boolean(takeProposal(id));
}

export function rejectAllLibraryProposals(sessionId?: string): number {
  if (sessionId) {
    const n = pendingBySession.get(sessionId)?.length ?? 0;
    pendingBySession.delete(sessionId);
    return n;
  }
  let n = 0;
  for (const list of pendingBySession.values()) n += list.length;
  pendingBySession.clear();
  return n;
}

export async function acceptLibraryProposal(
  id: string,
): Promise<{ paper: PaperRecord; created: boolean; proposal: LibraryProposalView }> {
  const item = takeProposal(id);
  if (!item) throw err(404, "Proposal not found or already reviewed");
  const result = await addVerifiedPaper(item.proposal);
  if (!result.ok) {
    // Put it back so the host can retry / dismiss after seeing the error.
    const list = pendingBySession.get(item.sessionId) ?? [];
    list.unshift(item);
    pendingBySession.set(item.sessionId, list);
    throw err(422, `${result.code}: ${result.reason}`);
  }
  return {
    paper: result.paper,
    created: result.created,
    proposal: proposalView(item),
  };
}

export async function acceptAllLibraryProposals(sessionId?: string): Promise<{
  accepted: Array<{ paper: PaperRecord; proposalId: string }>;
  errors: Array<{ proposalId: string; error: string }>;
}> {
  const items = listPendingLibraryProposals(sessionId);
  const accepted: Array<{ paper: PaperRecord; proposalId: string }> = [];
  const errors: Array<{ proposalId: string; error: string }> = [];
  for (const item of items) {
    try {
      const result = await acceptLibraryProposal(item.id);
      accepted.push({ paper: result.paper, proposalId: item.id });
    } catch (e) {
      errors.push({
        proposalId: item.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { accepted, errors };
}

/** Drop pending proposals when a library AI session is revoked. */
export function clearLibraryProposalsForSession(sessionId: string): void {
  pendingBySession.delete(sessionId);
}
