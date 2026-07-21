import type { Identity } from "./types";

function storageKey(projectId: string): string {
  return `openleaf.identityId.${projectId}`;
}

export function loadStoredIdentityId(projectId: string): string | null {
  try {
    return localStorage.getItem(storageKey(projectId));
  } catch {
    return null;
  }
}

export function storeIdentityId(projectId: string, id: string): void {
  try {
    localStorage.setItem(storageKey(projectId), id);
  } catch {
    /* ignore */
  }
}

export function pickIdentity(identities: Identity[], preferredId?: string | null): Identity | null {
  if (identities.length === 0) return null;
  if (preferredId) {
    const hit = identities.find((i) => i.id === preferredId);
    if (hit) return hit;
  }
  return identities[0] ?? null;
}
