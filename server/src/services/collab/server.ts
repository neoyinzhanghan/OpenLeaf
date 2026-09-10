import type { Server as HttpServer, IncomingMessage } from "node:http";
import fs from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import type { Identity } from "../../config.js";
import { getProjectIdentity, projectDir } from "../projectFs.js";
import { isTunnelRequest, resolveGuest } from "../shareAuth.js";
import { getOrCreateRoom, releaseRoomIfEmpty, type ProjectRoom } from "./room.js";

const messageSync = 0;
const messageAwareness = 1;

type RoomHub = {
  awareness: awarenessProtocol.Awareness;
  conns: Map<WebSocket, Set<number>>;
};

const hubs = new WeakMap<ProjectRoom, RoomHub>();

function getHub(room: ProjectRoom): RoomHub {
  let hub = hubs.get(room);
  if (hub) return hub;

  const awareness = new awarenessProtocol.Awareness(room.doc);
  hub = { awareness, conns: new Map() };
  hubs.set(room, hub);

  awareness.on(
    "update",
    (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      const changed = added.concat(updated, removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
      );
      const payload = encoding.toUint8Array(encoder);
      for (const [conn] of hub!.conns) {
        if (conn !== origin && conn.readyState === WebSocket.OPEN) {
          conn.send(payload);
        }
      }
    },
  );

  return hub;
}

function parseCollabUrl(
  req: IncomingMessage,
): { projectId: string; identityId: string; branchId: string } | null {
  try {
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (!url.pathname.startsWith("/collab")) return null;

    const parts = url.pathname.replace(/^\/collab\/?/, "").split("/").filter(Boolean);
    const projectId = parts[0] || url.searchParams.get("project") || "";
    const identityId = url.searchParams.get("identity") || "";
    const branchId = (url.searchParams.get("branch") || "main").trim() || "main";
    if (!projectId || !identityId) return null;
    return { projectId, identityId, branchId };
  } catch {
    return null;
  }
}

/** Well-formed HTTP rejection for a failed upgrade (proxies choke on header-less replies). */
function rejectUpgrade(socket: import("node:stream").Duplex, code: number, text: string): void {
  socket.write(
    `HTTP/1.1 ${code} ${text}\r\nContent-Type: text/plain\r\nContent-Length: ${text.length}\r\nConnection: close\r\n\r\n${text}`,
  );
  socket.destroy();
}

function send(conn: WebSocket, encoder: encoding.Encoder): void {
  if (conn.readyState === WebSocket.OPEN) {
    conn.send(encoding.toUint8Array(encoder));
  }
}

export function attachCollabServer(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    void (async () => {
      const parsed = parseCollabUrl(req);
      if (!parsed) {
        if ((req.url ?? "").startsWith("/collab")) {
          rejectUpgrade(socket, 400, "Bad Request");
        }
        return;
      }

      try {
        const dir = projectDir(parsed.projectId);
        if (!fs.existsSync(dir)) {
          rejectUpgrade(socket, 404, "Not Found");
          return;
        }
      } catch {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }

      let identity: Identity | undefined;
      let readOnly = false;
      let branchId = parsed.branchId;
      if (isTunnelRequest(req)) {
        // Guest via share link: identity comes from the signed-in guest, never from the URL.
        // Bound branch stays editable (unless share is RO). Other branches are observe-only
        // so guests can watch live uncommitted leaves across the multiverse.
        const r = resolveGuest(req);
        if (r.reason !== "ok") {
          rejectUpgrade(socket, 401, "Unauthorized");
          return;
        }
        if (r.session.projectId !== parsed.projectId) {
          rejectUpgrade(socket, 403, "Forbidden");
          return;
        }
        identity = { id: r.guest.id, name: r.guest.name, color: r.guest.color };
        const bound = r.session.branchId || "main";
        const requested = parsed.branchId || bound;
        branchId = requested;
        readOnly = r.session.settings.readOnly || requested !== bound;
      } else {
        identity = await getProjectIdentity(parsed.projectId, parsed.identityId);
      }
      if (!identity) {
        rejectUpgrade(socket, 403, "Forbidden");
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, { ...parsed, branchId, identity, readOnly });
      });
    })();
  });

  wss.on(
    "connection",
    async (
      conn: WebSocket,
      _req: IncomingMessage,
      parsed: {
        projectId: string;
        identityId: string;
        branchId: string;
        identity: Identity;
        readOnly: boolean;
      },
    ) => {
      let room: ProjectRoom;
      try {
        room = await getOrCreateRoom(parsed.projectId, parsed.branchId || "main");
      } catch (err) {
        console.error("[collab] room open failed", err);
        conn.close();
        return;
      }

      const hub = getHub(room);
      const { awareness, conns } = hub;
      room.addClient(conn);
      conns.set(conn, new Set());

      const onDocUpdate = (update: Uint8Array, origin: unknown) => {
        if (origin === conn) return;
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.writeUpdate(encoder, update);
        send(conn, encoder);
      };
      room.doc.on("update", onDocUpdate);

      {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.writeSyncStep1(encoder, room.doc);
        send(conn, encoder);
      }

      {
        const awareIds = Array.from(awareness.getStates().keys());
        if (awareIds.length > 0) {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, messageAwareness);
          encoding.writeVarUint8Array(
            encoder,
            awarenessProtocol.encodeAwarenessUpdate(awareness, awareIds),
          );
          send(conn, encoder);
        }
      }

      conn.on("message", (data: WebSocket.RawData) => {
        try {
          const buf =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array(data as Buffer);
          const decoder = decoding.createDecoder(buf);
          const messageType = decoding.readVarUint(decoder);
          switch (messageType) {
            case messageSync: {
              const encoder = encoding.createEncoder();
              encoding.writeVarUint(encoder, messageSync);
              if (parsed.readOnly) {
                // Read-only guests may request state (step 1) but any update they
                // send (step 2 / update) is dropped so the shared doc never changes.
                const syncType = decoding.readVarUint(decoder);
                if (syncType === syncProtocol.messageYjsSyncStep1) {
                  syncProtocol.readSyncStep1(decoder, encoder, room.doc);
                }
              } else {
                syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn);
              }
              if (encoding.length(encoder) > 1) send(conn, encoder);
              break;
            }
            case messageAwareness: {
              awarenessProtocol.applyAwarenessUpdate(
                awareness,
                decoding.readVarUint8Array(decoder),
                conn,
              );
              break;
            }
            default:
              break;
          }
        } catch (err) {
          console.error("[collab] message error", err);
        }
      });

      const onAwarenessTrack = (
        { added, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        if (origin !== conn) return;
        const controlled = conns.get(conn);
        if (!controlled) return;
        for (const id of added) controlled.add(id);
        for (const id of removed) controlled.delete(id);
      };
      awareness.on("update", onAwarenessTrack);

      (conn as WebSocket & { openleafIdentity?: Identity }).openleafIdentity = parsed.identity;

      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        awareness.off("update", onAwarenessTrack);
        room.doc.off("update", onDocUpdate);
        const controlled = conns.get(conn);
        conns.delete(conn);
        room.removeClient(conn);
        if (controlled && controlled.size > 0) {
          awarenessProtocol.removeAwarenessStates(awareness, [...controlled], "disconnect");
        }
        await releaseRoomIfEmpty(parsed.projectId, parsed.branchId || "main");
      };

      conn.on("close", () => {
        void close();
      });
      conn.on("error", () => {
        void close();
      });
    },
  );

  return wss;
}
