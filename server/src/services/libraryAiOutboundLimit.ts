/**
 * In-memory cap on outbound library AI calls (lookup / verify).
 * One process, one machine — a sliding window per AI-link session is enough.
 */
import type { LibraryAiError } from "./libraryAiShare.js";

export const LIBRARY_AI_OUTBOUND_LIMIT = 30;
export const LIBRARY_AI_OUTBOUND_WINDOW_MS = 60_000;

const hits = new Map<string, number[]>();

function tooMany(): LibraryAiError {
  return Object.assign(
    new Error("Too many lookup/verify requests. Wait a minute and try again."),
    { status: 429 },
  );
}

export function assertLibraryAiOutbound(sessionId: string, now = Date.now()): void {
  const windowStart = now - LIBRARY_AI_OUTBOUND_WINDOW_MS;
  const recent = (hits.get(sessionId) ?? []).filter((stamp) => stamp > windowStart);
  if (recent.length >= LIBRARY_AI_OUTBOUND_LIMIT) {
    hits.set(sessionId, recent);
    throw tooMany();
  }
  recent.push(now);
  hits.set(sessionId, recent);
  if (hits.size > 2000) {
    const oldest = hits.keys().next().value;
    if (oldest && oldest !== sessionId) hits.delete(oldest);
  }
}

export function resetLibraryAiOutboundLimitsForTests(): void {
  hits.clear();
}
