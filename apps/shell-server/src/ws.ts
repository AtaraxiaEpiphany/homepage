import type { FastifyPluginAsync } from "fastify";
import type { WebSocket } from "ws";
import type { C2S, S2C } from "@homepage/shared";
import { config } from "./config.js";
import { Session, SessionRegistry } from "./session.js";

const MAX_CONTROL_FRAME = 64 * 1024; // JSON text frames
const MAX_INPUT_FRAME = 1024 * 1024; // raw stdin bytes (paste guard)

interface ConnState {
  session: Session | null;
}

export const wsRoutes: FastifyPluginAsync = async (app) => {
  const registry = new SessionRegistry(
    config.maxSessions,
    config.reattachGraceMs,
    config.idleTimeoutMs,
  );
  app.addHook("onClose", async () => registry.dispose());

  app.get("/ws", { websocket: true }, (socketRaw: WebSocket, req) => {
    if (config.token && req.query !== undefined) {
      const url = new URL(req.url, "http://localhost");
      if (url.searchParams.get("token") !== config.token) {
        socketRaw.close(4401, "unauthorized");
        return;
      }
    }

    const state: ConnState = { session: null };
    socketRaw.binaryType = "nodebuffer";

    const send = (msg: S2C) => {
      if (socketRaw.readyState === socketRaw.OPEN) socketRaw.send(JSON.stringify(msg));
    };

    const bind = (session: Session) => {
      state.session = session;
      session.attach({
        send: (data: Buffer) => {
          if (socketRaw.readyState === socketRaw.OPEN) socketRaw.send(data, { binary: true });
        },
        close: (code: number, reason: string) => {
          // Null BEFORE closing the socket: the late 'close' event runs
          // state.session?.detach() — if it still pointed at the session it
          // would unbind whoever superseded us.
          state.session = null;
          if (socketRaw.readyState === socketRaw.OPEN) socketRaw.close(code, reason);
        },
        readyState: socketRaw.readyState,
      });
    };

    socketRaw.on("message", (data: Buffer, isBinary: boolean) => {
      // Binary frames are raw stdin bytes for the bound session.
      if (isBinary) {
        if (data.length > MAX_INPUT_FRAME) return;
        state.session?.write(data);
        return;
      }
      if (data.length > MAX_CONTROL_FRAME) return;

      let msg: C2S;
      try {
        msg = JSON.parse(data.toString("utf8")) as C2S;
      } catch {
        return;
      }

      switch (msg.type) {
        case "create": {
          if (state.session && !state.session.exited) {
            send({ type: "error", code: "busy", message: "connection already owns a session" });
            return;
          }
          if (registry.size >= config.maxSessions) {
            send({ type: "error", code: "server_full", message: "too many live sessions" });
            return;
          }
          const cols = 80;
          const rows = 24;
          const session = registry.create(cols, rows);
          bind(session);
          send({ type: "created", sessionId: session.id });
          break;
        }
        case "attach": {
          if (state.session && !state.session.exited) {
            send({ type: "error", code: "busy", message: "connection already owns a session" });
            return;
          }
          const session = registry.get(msg.sessionId);
          if (session && !session.exited) {
            bind(session);
            session.touch();
            session.nudge(); // repaint for the freshly blank client screen
            send({ type: "attached", sessionId: session.id, ok: true });
          } else {
            send({ type: "attached", sessionId: msg.sessionId, ok: false });
          }
          break;
        }
        case "resize": {
          state.session?.resize(msg.cols, msg.rows);
          break;
        }
        case "status": {
          send({
            type: "status",
            sessions: registry.size,
            maxSessions: config.maxSessions,
            uptimeSec: Math.floor(process.uptime()),
            image: config.image,
          });
          break;
        }
        case "ping": {
          send({ type: "pong" });
          break;
        }
      }
    });

    socketRaw.on("close", () => {
      state.session?.detach();
    });

    socketRaw.on("error", () => {
      state.session?.detach();
    });
  });
};
