import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { RedisClientType } from "redis";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import type { AdmissionStore } from "./admission/index.js";
import {
  HEARTBEAT_MS,
  HOST_STALE_MS,
  HOSTS_KEY,
  QUEUE_KEY,
  TICKET_KEY,
  type HostRecord,
} from "./admission/redis.js";
import { sanitizeVisitor } from "./ws.js";
import { rateLimiter } from "./ratelimit.js";
import { isDraining } from "./shutdown.js";
import { incCounter } from "./metrics.js";

export interface BrokerOptions {
  redis: RedisClientType;
  store: AdmissionStore;
  capacityUsed: () => number;
}

const socketIp = (request: FastifyRequest): string => {
  const raw = request.socket?.remoteAddress ?? "unknown";
  return raw.startsWith("::ffff:") ? raw.slice(7) : raw;
};

/**
 * Broker mode control plane. Admission decisions are per-host, so any
 * broker-enabled host can answer; the queue and tickets live in the shared
 * redis (see admission/redis.ts for the key layout). The data plane stays
 * client↔host WS direct — sessions and their secrets never touch these
 * routes.
 *
 * HTTP tickets are unpinned (p: null): any host with headroom may grant
 * them, unlike WS-waiter tickets which only their own host can complete.
 */
export const brokerRoutes: FastifyPluginAsync<BrokerOptions> = async (app, opts) => {
  const { redis, store, capacityUsed } = opts;

  const beat = async (): Promise<void> => {
    try {
      const rec: HostRecord = {
        url: config.hostPublicUrl === "" ? null : config.hostPublicUrl,
        bound: capacityUsed(),
        max: config.maxSessions,
        ts: Date.now(),
      };
      await redis.hSet(HOSTS_KEY, config.hostId, JSON.stringify(rec));
    } catch (err) {
      incCounter("redis_errors_total", { op: "heartbeat" });
      app.log.warn({ err }, "broker heartbeat failed");
    }
  };
  await beat();
  const heartbeat = setInterval(() => void beat(), HEARTBEAT_MS);
  heartbeat.unref();

  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    try {
      await redis.hDel(HOSTS_KEY, config.hostId);
    } catch {
      // redis already gone — nothing to retract
    }
  });

  /**
   * Preflight: reserve a slot on this host (local headroom) or take a
   * waiting-room ticket. Shares the per-IP create bucket with the WS path —
   * an admission attempt is a create attempt whichever channel it arrives
   * on; the redeeming `create{ticket}` skips the bucket (the ticket is the
   * proof of payment).
   */
  app.post("/api/admit", async (request, reply) => {
    incCounter("admit_requests_total");
    if (isDraining()) {
      return reply.code(503).send({ granted: false, error: "draining" });
    }
    if (!config.rateLimitDisabled && !rateLimiter.hitCreate(socketIp(request)).ok) {
      incCounter("rejections_total", { code: "rate_limited" });
      return reply.code(429).send({ granted: false, error: "rate_limited" });
    }
    const body = (request.body ?? {}) as { visitor?: unknown };
    const visitor = sanitizeVisitor(body.visitor);

    const verdict = await store.tryAcquire(visitor);
    if (verdict.verdict === "admit") {
      // Reserved here, redeemed over WS. If the client never shows up the
      // ticket expires; the budget charge happens at redeem, not here.
      const ticket = randomUUID();
      await redis.set(
        TICKET_KEY(ticket),
        JSON.stringify({
          s: "admitted",
          v: visitor,
          u: config.hostPublicUrl === "" ? null : config.hostPublicUrl,
        }),
        { PX: 30_000 },
      );
      return {
        granted: true,
        ticket,
        endpoint: config.hostPublicUrl === "" ? null : config.hostPublicUrl,
      };
    }
    if (verdict.verdict === "queue") {
      // Unpinned global ticket: whichever host drains next serves it.
      const ticket = randomUUID();
      await redis.rPush(QUEUE_KEY, ticket);
      await redis.set(
        TICKET_KEY(ticket),
        JSON.stringify({ s: "queued", v: visitor, p: null }),
        { PX: 120_000 },
      );
      const idx = await redis.lPos(QUEUE_KEY, ticket);
      return { granted: false, queued: true, ticket, position: (idx ?? -1) + 1 };
    }
    incCounter("rejections_total", { code: verdict.code });
    return reply.code(429).send({ granted: false, error: verdict.code });
  });

  app.get("/api/queue/:ticket", async (request, reply) => {
    const { ticket } = request.params as { ticket: string };
    if (!/^[\w-]{8,64}$/.test(ticket)) {
      return reply.code(404).send({ error: "ticket_unknown" });
    }
    const raw = await redis.get(TICKET_KEY(ticket));
    if (!raw) return reply.code(404).send({ error: "ticket_unknown" });
    let t: { s?: string; u?: string | null };
    try {
      t = JSON.parse(raw);
    } catch {
      return reply.code(404).send({ error: "ticket_unknown" });
    }
    if (t.s === "queued") {
      const idx = await redis.lPos(QUEUE_KEY, ticket);
      return { granted: false, queued: true, position: (idx ?? -1) + 1 };
    }
    if (t.s === "granted" || t.s === "admitted") {
      return { granted: true, endpoint: t.u ?? null };
    }
    return reply.code(404).send({ error: "ticket_unknown" });
  });

  /** Ops view: which hosts are alive and how loaded (freshness per record). */
  app.get("/api/hosts", async () => {
    const all = await redis.hGetAll(HOSTS_KEY);
    const now = Date.now();
    const hosts = Object.entries(all).map(([id, raw]) => {
      try {
        const rec = JSON.parse(raw) as HostRecord;
        return {
          id,
          url: rec.url ?? null,
          bound: rec.bound,
          max: rec.max,
          fresh: now - rec.ts < HOST_STALE_MS,
          ageSec: Math.round((now - rec.ts) / 1000),
        };
      } catch {
        return { id, url: null, bound: -1, max: -1, fresh: false, ageSec: -1 };
      }
    });
    hosts.sort((a, b) => a.id.localeCompare(b.id));
    return { hosts };
  });
};
