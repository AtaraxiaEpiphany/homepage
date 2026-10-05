import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { C2S, S2C } from "@homepage/shared";
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { Session, SessionRegistry } from "./session.js";
import { incCounter } from "./metrics.js";
import { isDraining } from "./shutdown.js";
import { rateLimiter } from "./ratelimit.js";
import type { AdmissionStore, QueueHandle } from "./admission/index.js";

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
  /** Live waiting-room ticket, if this connection is queued for a slot. */
  queueHandle: QueueHandle | null;
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

export const wsRoutes: FastifyPluginAsync<{ registry: SessionRegistry; admission: AdmissionStore }> = async (
  app,
  { registry, admission },
) => {
  app.addHook("onClose", async () => {
    admission.dispose();
    registry.dispose();
  });

  // Session ends are the single admission refund path: charge happens at
  // admit/grant, this fires exactly once per created session's shell exit.
  registry.onSessionEnd = (s) => admission.release(s.visitorId);

  // Fan queue positions out to every waiting connection on any change.
  const queuedConns = new Set<{ state: ConnState; send: (msg: S2C) => void }>();
  admission.onDepthChange(() => {
    for (const conn of queuedConns) {
      if (conn.state.queueHandle) {
        conn.send({ type: "queue_update", position: conn.state.queueHandle.position() });
      }
    }
  });

  app.get("/ws", { websocket: true }, (socketRaw: WebSocket, request: FastifyRequest) => {
    // First-frame token auth. The browser WebSocket API cannot set headers,
    // so the token travels as the first control message instead of the URL —
    // which also keeps it out of request logs. Everything but `auth` is
    // ignored until the handshake lands; silence or abuse closes 4401.
    const ip = socketIp(request);
    const state: ConnState = { session: null, authed: !config.token, ip, visitor: null, queueHandle: null };
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

    // The tail of every create path (direct admit or queue grant). Capacity
    // was charged by admission before this runs — every refusal here refunds.
    const finishCreate = () => {
      if (isDraining()) {
        admission.release(state.visitor);
        incCounter("rejections_total", { code: "draining" });
        send({ type: "error", code: "draining", message: "server is shutting down — retry shortly" });
        return;
      }
      if (state.session && !state.session.exited) {
        admission.release(state.visitor);
        incCounter("rejections_total", { code: "busy" });
        send({ type: "error", code: "busy", message: "connection already owns a session" });
        return;
      }
      incCounter("session_creates_total");
      let session: Session;
      try {
        session = registry.create(80, 24);
      } catch (err) {
        admission.release(state.visitor);
        incCounter("rejections_total", { code: "spawn_failed" });
        app.log.error({ err }, "session spawn failed");
        send({ type: "error", code: "spawn_failed", message: "failed to start the shell container" });
        return;
      }
      session.visitorId = state.visitor;
      bind(session);
      send({ type: "created", sessionId: session.id, secret: session.secret });
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
          if (state.queueHandle) {
            // Already waiting — restate the position, change nothing.
            send({
              type: "queued",
              ticket: state.queueHandle.ticket,
              position: state.queueHandle.position(),
            });
            return;
          }
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
          const verdict = admission.tryAcquire(state.visitor);
          if (verdict.verdict === "reject") {
            incCounter("rejections_total", { code: verdict.code });
            const message =
              verdict.code === "visitor_limit"
                ? "this browser already holds a session — close it or reload that tab"
                : verdict.code === "queue_full"
                  ? "waiting room is full — try again soon"
                  : "too many live sessions and no queue room";
            send({ type: "error", code: verdict.code, message });
            return;
          }
          if (verdict.verdict === "queue") {
            const handle = admission.enqueue(state.visitor);
            state.queueHandle = handle;
            const conn = { state, send };
            queuedConns.add(conn);
            send({ type: "queued", ticket: handle.ticket, position: handle.position() });
            void handle.granted().then((outcome) => {
              state.queueHandle = null;
              queuedConns.delete(conn);
              if (outcome === "granted") finishCreate();
              else if (outcome === "timeout") {
                send({ type: "error", code: "queue_timeout", message: "waited too long for a slot" });
              }
              // "canceled": the connection is closing; nothing to send.
            });
            return;
          }
          finishCreate();
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
            queueDepth: admission.queueDepth(),
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
      // A ticket lives exactly as long as its connection.
      state.queueHandle?.cancel();
      state.queueHandle = null;
      state.session?.detach();
    };

    socketRaw.on("close", cleanup);
    socketRaw.on("error", cleanup);
  });
};
