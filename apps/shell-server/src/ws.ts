import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { C2S, S2C } from "@homepage/shared";
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { Session, SessionRegistry } from "./session.js";
import { incCounter } from "./metrics.js";
import { isDraining } from "./shutdown.js";
import { rateLimiter } from "./ratelimit.js";

const MAX_CONTROL_FRAME = 64 * 1024; // JSON text frames
const MAX_INPUT_FRAME = 1024 * 1024; // raw stdin bytes (paste guard)
const AUTH_DEADLINE_MS = 5_000; // first-frame auth budget when WS_TOKEN is set

/**
 * timingSafeEqual throws on length mismatches, and attacker-supplied strings
 * are arbitrary — compare fixed-size SHA-256 digests instead.
 */
const safeEqual = (a: string, b: string): boolean =>
  timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );

interface ConnState {
  session: Session | null;
  /** Token handshake done — everything but `auth` is ignored until true. */
  authed: boolean;
  /** Raw socket address — the abuse floor. Never a forwarded header. */
  ip: string;
  /** Visitor fairness key from `auth`/`create`, once a valid one arrives. */
  visitor: string | null;
}

/** Visitor tokens are opaque server-side; shape-check only. */
const VISITOR_RE = /^[\w-]{8,128}$/;

const sanitizeVisitor = (v: unknown): string | null =>
  typeof v === "string" && VISITOR_RE.test(v) ? v : null;

/** Normalize IPv4-mapped IPv6 so the limiter sees one form per address. */
const socketIp = (request: FastifyRequest): string => {
  const raw = request.socket?.remoteAddress ?? "unknown";
  return raw.startsWith("::ffff:") ? raw.slice(7) : raw;
};

export const wsRoutes: FastifyPluginAsync<{ registry: SessionRegistry }> = async (app, { registry }) => {
  app.addHook("onClose", async () => registry.dispose());

  app.get("/ws", { websocket: true }, (socketRaw: WebSocket, request: FastifyRequest) => {
    // First-frame token auth. The browser WebSocket API cannot set headers,
    // so the token travels as the first control message instead of the URL —
    // which also keeps it out of request logs. Everything but `auth` is
    // ignored until the handshake lands; silence or abuse closes 4401.
    const ip = socketIp(request);
    const state: ConnState = { session: null, authed: !config.token, ip, visitor: null };
    socketRaw.binaryType = "nodebuffer";
    incCounter("ws_connections_total");

    // Per-IP concurrent-connection cap — checked before any auth work. When
    // the cap rejects, `cleanup` must not release a count we never took.
    let wsCounted = false;
    if (!config.rateLimitDisabled && !rateLimiter.wsAcquire(ip)) {
      incCounter("rejections_total", { code: "connection_limit" });
      socketRaw.close(4429, "too many connections from this address");
      return;
    }
    wsCounted = true;

    let authTimer: NodeJS.Timeout | null = null;
    if (config.token) {
      authTimer = setTimeout(() => socketRaw.close(4401, "auth timeout"), AUTH_DEADLINE_MS);
      authTimer.unref();
    }

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
      if (!state.authed) {
        if (
          !config.rateLimitDisabled &&
          rateLimiter.isLockedOut(ip)
        ) {
          incCounter("rejections_total", { code: "locked_out" });
          socketRaw.close(4403, `locked out for ${rateLimiter.lockoutRemainingSec(ip)}s`);
          return;
        }
        if (isBinary) {
          incCounter("auth_failures_total");
          if (
            !config.rateLimitDisabled &&
            rateLimiter.hitAuthFail(ip).locked
          ) {
            socketRaw.close(4403, "locked out after repeated auth failures");
            return;
          }
          socketRaw.close(4401, "unauthorized");
          return;
        }
        if (data.length > MAX_CONTROL_FRAME) return;

        let msg: C2S;
        try {
          msg = JSON.parse(data.toString("utf8")) as C2S;
        } catch {
          return;
        }
        if (
          msg.type !== "auth" ||
          typeof msg.token !== "string" ||
          !safeEqual(msg.token, config.token)
        ) {
          incCounter("auth_failures_total");
          if (
            !config.rateLimitDisabled &&
            rateLimiter.hitAuthFail(ip).locked
          ) {
            socketRaw.close(4403, "locked out after repeated auth failures");
            return;
          }
          socketRaw.close(4401, "unauthorized");
          return;
        }
        state.visitor = sanitizeVisitor(msg.visitor) ?? state.visitor;
        state.authed = true;
        if (!config.rateLimitDisabled) rateLimiter.clearAuthFailures(ip);
        if (authTimer !== null) {
          clearTimeout(authTimer);
          authTimer = null;
        }
        return;
      }

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
          state.visitor = sanitizeVisitor(msg.visitor) ?? state.visitor;
          if (isDraining()) {
            incCounter("rejections_total", { code: "draining" });
            send({ type: "error", code: "draining", message: "server is shutting down — retry shortly" });
            return;
          }
          if (state.session && !state.session.exited) {
            incCounter("rejections_total", { code: "busy" });
            send({ type: "error", code: "busy", message: "connection already owns a session" });
            return;
          }
          if (!config.rateLimitDisabled) {
            const verdict = rateLimiter.hitCreate(ip);
            if (!verdict.ok) {
              incCounter("rejections_total", { code: "rate_limited" });
              send({
                type: "error",
                code: "rate_limited",
                message: `too many session requests — retry in ${verdict.retryAfterSec}s`,
              });
              return;
            }
          }
          if (registry.size >= config.maxSessions) {
            incCounter("rejections_total", { code: "server_full" });
            send({ type: "error", code: "server_full", message: "too many live sessions" });
            return;
          }
          incCounter("session_creates_total");
          const cols = 80;
          const rows = 24;
          const session = registry.create(cols, rows);
          bind(session);
          send({ type: "created", sessionId: session.id, secret: session.secret });
          break;
        }
        case "attach": {
          if (state.session && !state.session.exited) {
            incCounter("rejections_total", { code: "busy" });
            send({ type: "error", code: "busy", message: "connection already owns a session" });
            return;
          }
          const session = registry.get(msg.sessionId);
          if (
            session &&
            !session.exited &&
            typeof msg.secret === "string" &&
            safeEqual(msg.secret, session.secret)
          ) {
            incCounter("attach_ok_total");
            bind(session);
            session.touch();
            session.nudge(); // repaint for the freshly blank client screen
            send({ type: "attached", sessionId: session.id, ok: true });
          } else {
            // Gone or wrong secret — indistinguishable on purpose; the client
            // falls back to `create` either way.
            incCounter("attach_fail_total");
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

    const cleanup = () => {
      if (authTimer !== null) {
        clearTimeout(authTimer);
        authTimer = null;
      }
      if (!config.rateLimitDisabled && wsCounted) rateLimiter.wsRelease(ip);
      state.session?.detach();
    };

    socketRaw.on("close", cleanup);
    socketRaw.on("error", cleanup);
  });
};
