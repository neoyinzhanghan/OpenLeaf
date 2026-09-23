/**
 * Library AI collaborator links — Bearer token + MCP for external AIs (ChatGPT)
 * to search / verify / add papers into the host citation library.
 *
 * Unlike project AI links (sandbox forks), this mutates the real library — but
 * every add is gated by verifyProposal (DOI/arXiv must resolve; no Scholar-only).
 */
import crypto from "node:crypto";
import { loadConfig } from "../config.js";
import { getHostGateway } from "./hostGateway.js";
import {
  buildLibraryMcpConfigJson,
  buildLibraryStarterPrompt,
  mcpUrlFromApiBase,
} from "./aiPrompt.js";

export type LibraryAiSettings = {
  allowSearch: boolean;
  allowAdd: boolean;
  allowEnrich: boolean;
  /** Soft cap on successful adds for this token. */
  maxAdds: number;
  title: string;
};

export type LibraryAiSession = {
  id: string;
  token: string;
  createdAt: number;
  expiresAt: number | null;
  revoked: boolean;
  settings: LibraryAiSettings;
  addCount: number;
  verifyCount: number;
  expiryTimer: NodeJS.Timeout | null;
};

export type LibraryAiError = Error & { status: number };

function err(status: number, message: string): LibraryAiError {
  return Object.assign(new Error(message), { status });
}

const byToken = new Map<string, string>();
const byId = new Map<string, LibraryAiSession>();

function makeToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

function makeId(): string {
  return `libai_${crypto.randomBytes(8).toString("hex")}`;
}

function publicBaseUrl(port?: number): string {
  const gw = getHostGateway();
  if (gw?.url && gw.status === "active") return gw.url.replace(/\/$/, "");
  const p = port ?? loadConfig().port;
  return `http://127.0.0.1:${p}`;
}

function normalizeSettings(input: Partial<LibraryAiSettings> | undefined): LibraryAiSettings {
  return {
    allowSearch: input?.allowSearch !== false,
    allowAdd: input?.allowAdd !== false,
    allowEnrich: Boolean(input?.allowEnrich),
    maxAdds: Math.min(500, Math.max(1, Math.floor(input?.maxAdds ?? 50))),
    title: (input?.title ?? "Library AI").trim() || "Library AI",
  };
}

function armExpiry(s: LibraryAiSession): void {
  if (s.expiryTimer) clearTimeout(s.expiryTimer);
  if (s.expiresAt == null) return;
  const delay = s.expiresAt - Date.now();
  if (delay <= 0) {
    revokeLibraryAi(s.id);
    return;
  }
  s.expiryTimer = setTimeout(() => revokeLibraryAi(s.id), delay);
}

function isExpired(s: LibraryAiSession): boolean {
  return s.expiresAt != null && Date.now() > s.expiresAt;
}

export function isLibraryAiDead(s: LibraryAiSession): boolean {
  return s.revoked || isExpired(s);
}

export type LibraryAiAuth = {
  session: LibraryAiSession;
  publicUrl: string;
  apiBase: string;
};

export function resolveLibraryAiToken(token: string | undefined): LibraryAiAuth | null {
  if (!token) return null;
  const id = byToken.get(token);
  if (!id) return null;
  const session = byId.get(id);
  if (!session || session.token !== token) return null;
  if (session.revoked) return null;
  if (isExpired(session)) {
    revokeLibraryAi(session.id);
    return null;
  }
  const publicUrl = publicBaseUrl();
  return {
    session,
    publicUrl,
    apiBase: `${publicUrl}/api/library-ai/v1`,
  };
}

export function mintLibraryAi(input: {
  settings?: Partial<LibraryAiSettings>;
  ttlMinutes?: number | null;
  riskAck?: boolean;
  port?: number;
}): {
  session: LibraryAiSession;
  libraryAiUrl: string;
  starterPrompt: string;
  mcpUrl: string;
  mcpConfig: string;
} {
  if (!input.riskAck) {
    throw err(400, "riskAck must be true — confirm you understand this link can write to your library");
  }
  const settings = normalizeSettings(input.settings);
  let expiresAt: number | null = null;
  if (input.ttlMinutes != null && Number.isFinite(input.ttlMinutes) && input.ttlMinutes > 0) {
    expiresAt = Date.now() + Math.min(30 * 24 * 60, Math.floor(input.ttlMinutes)) * 60_000;
  } else if (input.ttlMinutes === undefined) {
    // Default 7 days when omitted.
    expiresAt = Date.now() + 7 * 24 * 60 * 60_000;
  }

  const session: LibraryAiSession = {
    id: makeId(),
    token: makeToken(),
    createdAt: Date.now(),
    expiresAt,
    revoked: false,
    settings,
    addCount: 0,
    verifyCount: 0,
    expiryTimer: null,
  };
  byId.set(session.id, session);
  byToken.set(session.token, session.id);
  armExpiry(session);

  const origin = publicBaseUrl(input.port);
  const libraryAiUrl = `${origin}/library-ai/${session.token}`;
  const apiBase = `${origin}/api/library-ai/v1`;
  const mcpUrl = mcpUrlFromApiBase(apiBase);
  console.log(`[library-ai] minted ${session.id} → ${libraryAiUrl}`);
  return {
    session,
    libraryAiUrl,
    starterPrompt: buildLibraryStarterPrompt(libraryAiUrl, session, apiBase),
    mcpUrl,
    mcpConfig: buildLibraryMcpConfigJson({ mcpUrl, token: session.token, title: settings.title }),
  };
}

export function revokeLibraryAi(id: string): boolean {
  const session = byId.get(id);
  if (!session) return false;
  if (session.expiryTimer) clearTimeout(session.expiryTimer);
  session.expiryTimer = null;
  session.revoked = true;
  byToken.delete(session.token);
  void import("./libraryAiReview.js").then((m) => m.clearLibraryProposalsForSession(id));
  console.log(`[library-ai] revoked ${session.id}`);
  return true;
}

export function listLibraryAiSessions(): LibraryAiSession[] {
  return [...byId.values()].filter((s) => {
    if (isExpired(s) && !s.revoked) revokeLibraryAi(s.id);
    return !isLibraryAiDead(s);
  });
}

export function getLibraryAiById(id: string): LibraryAiSession | null {
  return byId.get(id) ?? null;
}

export function libraryAiHostView(session: LibraryAiSession, port?: number) {
  const dead = isLibraryAiDead(session);
  const origin = publicBaseUrl(port);
  const libraryAiUrl = dead ? null : `${origin}/library-ai/${session.token}`;
  const apiBase = dead ? null : `${origin}/api/library-ai/v1`;
  const mcpUrl = apiBase ? mcpUrlFromApiBase(apiBase) : null;
  return {
    id: session.id,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    revoked: session.revoked || dead,
    settings: session.settings,
    addCount: session.addCount,
    verifyCount: session.verifyCount,
    libraryAiUrl,
    token: dead ? null : session.token,
    starterPrompt:
      libraryAiUrl && apiBase
        ? buildLibraryStarterPrompt(libraryAiUrl, session, apiBase)
        : null,
    mcpUrl,
    mcpConfig:
      mcpUrl && !dead
        ? buildLibraryMcpConfigJson({
            mcpUrl,
            token: session.token,
            title: session.settings.title,
          })
        : null,
  };
}

export function libraryAiBrief(auth: LibraryAiAuth): Record<string, unknown> {
  const { session, apiBase, publicUrl } = auth;
  return {
    kind: "openleaf-library-ai",
    title: session.settings.title,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    settings: {
      allowSearch: session.settings.allowSearch,
      allowAdd: session.settings.allowAdd,
      allowEnrich: session.settings.allowEnrich,
      maxAdds: session.settings.maxAdds,
    },
    usage: { addCount: session.addCount, verifyCount: session.verifyCount },
    auth: {
      header: "Authorization: Bearer <token>",
      note: "The token is the path segment of /library-ai/<token>. Never print the token in replies.",
    },
    apiBase,
    briefingUrl: `${publicUrl}/library-ai/${session.token}`,
    mcp: `${apiBase}/mcp`,
    rules: [
      "Every add is verify-first: DOI or arXiv must resolve in Crossref/OpenAlex/arXiv.",
      "Successful adds are queued for host Accept/Reject — not written until Accept.",
      "On reject, read code/hint/expected and retry once — never invent a DOI.",
      "Scholar-only or bare publisher URLs are rejected.",
    ],
    starterPrompt: buildLibraryStarterPrompt(
      `${publicUrl}/library-ai/${session.token}`,
      session,
      apiBase,
    ),
  };
}

export function assertLibraryAiSearch(session: LibraryAiSession): void {
  if (!session.settings.allowSearch) throw err(403, "Search is disabled for this library AI link");
}

export function assertLibraryAiAdd(session: LibraryAiSession): void {
  if (!session.settings.allowAdd) throw err(403, "Add is disabled for this library AI link");
  if (session.addCount >= session.settings.maxAdds) {
    throw err(429, `Add quota reached (${session.settings.maxAdds}). Ask the host for a new link.`);
  }
}

export function assertLibraryAiEnrich(session: LibraryAiSession): void {
  if (!session.settings.allowEnrich) throw err(403, "Enrich is disabled for this library AI link");
}

export function bumpVerify(session: LibraryAiSession): void {
  session.verifyCount += 1;
}

export function bumpAdd(session: LibraryAiSession): void {
  session.addCount += 1;
}
