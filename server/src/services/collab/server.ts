import type { Server as HttpServer, IncomingMessage } from "node:http";
import fs from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import type { Identity } from "../../config.js";
import { getProjectIdentity, projectDir } from "../projectFs.js";
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

function parseCollabUrl(req: IncomingMessage): { projectId: string; identityId: string } | null {
  try {
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (!url.pathname.startsWith("/collab")) return null;

    const parts = url.pathname.replace(/^\/collab\/?/, "").split("/").filter(Boolean);
    const projectId = parts[0] || url.searchParams.get("project") || "";
    const identityId = url.searchParams.get("identity") || "";
    if (!projectId || !identityId) return null;
    return { projectId, identityId };
  } catch {
    return null;
  }
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
          socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
          socket.destroy();
        }
        return;
      }

      try {
        const dir = projectDir(parsed.projectId);
        if (!fs.existsSync(dir)) {
          socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
          socket.destroy();
          return;
        }
      } catch {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      const identity = await getProjectIdentity(parsed.projectId, parsed.identityId);
      if (!identity) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, { ...parsed, identity });
      });
    })();
  });

  wss.on(
    "connection",
    async (
      conn: WebSocket,
      _req: IncomingMessage,
      parsed: { projectId: string; identityId: string; identity: Identity },
    ) => {
      let room: ProjectRoom;
      try {
        room = await getOrCreateRoom(parsed.projectId);
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
              syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn);
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
        await releaseRoomIfEmpty(parsed.projectId);
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
