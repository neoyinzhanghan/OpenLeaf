import { useCallback, useEffect, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import type { Awareness } from "y-protocols/awareness";
import { loadStoredIdentityId, pickIdentity, storeIdentityId } from "./identity";
import type { CollabPresence, Identity } from "./types";

export type CollabStatus = "connecting" | "connected" | "disconnected";

export type ProjectCollab = {
  doc: Y.Doc | null;
  awareness: Awareness | null;
  provider: WebsocketProvider | null;
  status: CollabStatus;
  synced: boolean;
  identities: Identity[];
  identity: Identity | null;
  setIdentityId: (id: string) => void;
  peers: CollabPresence[];
  getFileText: (path: string) => Y.Text | null;
  ensureFile: (path: string) => Promise<Y.Text | null>;
  treeVersion: number;
};

function collabWsBase(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/collab`;
}

/**
 * @param fixedIdentity When set (guest via share link), the identity is fixed by
 *   the server-side sign-in and the project identity list is not consulted.
 */
export function useProjectCollab(projectId: string | undefined, fixedIdentity?: Identity | null): ProjectCollab {
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [identityId, setIdentityIdState] = useState<string | null>(null);
  const [status, setStatus] = useState<CollabStatus>("disconnected");
  const [synced, setSynced] = useState(false);
  const [peers, setPeers] = useState<CollabPresence[]>([]);
  const [treeVersion, setTreeVersion] = useState(0);
  const [session, setSession] = useState<{
    doc: Y.Doc;
    awareness: Awareness;
    provider: WebsocketProvider;
  } | null>(null);
  const [filesTick, setFilesTick] = useState(0);

  const identity = fixedIdentity ?? pickIdentity(identities, identityId);

  const setIdentityId = useCallback(
    (id: string) => {
      if (!projectId || fixedIdentity) return;
      storeIdentityId(projectId, id);
      setIdentityIdState(id);
    },
    [projectId, fixedIdentity],
  );

  // Load per-project identities
  useEffect(() => {
    if (fixedIdentity) {
      setIdentities([fixedIdentity]);
      setIdentityIdState(fixedIdentity.id);
      return;
    }
    if (!projectId) {
      setIdentities([]);
      setIdentityIdState(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/identities`);
        if (!res.ok) throw new Error("Failed to load identities");
        const list = (await res.json()) as Identity[];
        if (cancelled) return;
        setIdentities(list);
        const preferred = loadStoredIdentityId(projectId);
        const picked = pickIdentity(list, preferred);
        if (picked) {
          setIdentityIdState(picked.id);
          storeIdentityId(projectId, picked.id);
        } else {
          setIdentityIdState(null);
        }
      } catch {
        if (!cancelled) {
          setIdentities([]);
          setIdentityIdState(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, fixedIdentity]);

  // Connect (or reconnect when project / identity changes — identity is part of the handshake)
  useEffect(() => {
    if (!projectId || !identity) {
      setSession(null);
      setStatus("disconnected");
      setSynced(false);
      setPeers([]);
      return;
    }

    const doc = new Y.Doc();
    const provider = new WebsocketProvider(collabWsBase(), projectId, doc, {
      params: { identity: identity.id },
      connect: true,
      disableBc: true,
    });

    provider.awareness.setLocalStateField("user", {
      id: identity.id,
      name: identity.name,
      color: identity.color,
    });

    setSession({ doc, awareness: provider.awareness, provider });
    setStatus(provider.wsconnected ? "connected" : "connecting");
    setSynced(false);

    const onStatus = ({ status: s }: { status: string }) => {
      if (s === "connected") setStatus("connected");
      else if (s === "connecting") setStatus("connecting");
      else setStatus("disconnected");
    };
    const onSync = (isSynced: boolean) => {
      setSynced(isSynced);
      setFilesTick((n) => n + 1);
    };
    const onAwareness = () => {
      const states = provider.awareness.getStates();
      const next: CollabPresence[] = [];
      states.forEach((state, clientId) => {
        const user = state?.user as { id?: string; name?: string; color?: string } | undefined;
        if (!user?.id || !user.name || !user.color) return;
        next.push({
          clientId,
          user: { id: user.id, name: user.name, color: user.color },
        });
      });
      setPeers(next);
    };

    const meta = doc.getMap("meta");
    const files = doc.getMap("files");
    const onMeta = () => {
      const v = meta.get("treeVersion");
      if (typeof v === "number") setTreeVersion(v);
    };
    const onFiles = () => setFilesTick((n) => n + 1);

    provider.on("status", onStatus);
    provider.on("sync", onSync);
    provider.awareness.on("change", onAwareness);
    meta.observe(onMeta);
    files.observe(onFiles);
    onAwareness();
    onMeta();

    return () => {
      meta.unobserve(onMeta);
      files.unobserve(onFiles);
      provider.awareness.off("change", onAwareness);
      provider.off("status", onStatus);
      provider.off("sync", onSync);
      provider.destroy();
      doc.destroy();
      setSession(null);
    };
  }, [projectId, identity?.id, identity?.name, identity?.color]);

  const getFileText = useCallback(
    (filePath: string): Y.Text | null => {
      void filesTick;
      if (!session) return null;
      return session.doc.getMap<Y.Text>("files").get(filePath) ?? null;
    },
    [session, filesTick],
  );

  const ensureFile = useCallback(
    async (filePath: string): Promise<Y.Text | null> => {
      if (!projectId || !session) return null;
      const existing = session.doc.getMap<Y.Text>("files").get(filePath);
      if (existing) return existing;
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/collab/ensure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath }),
      });
      if (!res.ok) return null;
      for (let i = 0; i < 40; i += 1) {
        const text = session.doc.getMap<Y.Text>("files").get(filePath);
        if (text) {
          setFilesTick((n) => n + 1);
          return text;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return session.doc.getMap<Y.Text>("files").get(filePath) ?? null;
    },
    [projectId, session],
  );

  return {
    doc: session?.doc ?? null,
    awareness: session?.awareness ?? null,
    provider: session?.provider ?? null,
    status,
    synced,
    identities,
    identity,
    setIdentityId,
    peers,
    getFileText,
    ensureFile,
    treeVersion,
  };
}

export async function flushCollab(
  projectId: string,
  opts?: { identityId?: string; message?: string },
): Promise<{ ok: boolean; git?: { committed: boolean; hash: string | null; message: string } }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/collab/flush`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts?.identityId ? { "X-OpenLeaf-Identity": opts.identityId } : {}),
    },
    body: JSON.stringify({
      identityId: opts?.identityId,
      message: opts?.message ?? "Save & sync",
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Flush failed");
  }
  return (await res.json()) as { ok: boolean; git?: { committed: boolean; hash: string | null; message: string } };
}
