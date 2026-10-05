import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { Session, SessionRegistry } from "./session.js";
import { WarmPool } from "./pool.js";
import { wsRoutes } from "./ws.js";
import { fileRoutes } from "./files.js";
import { render } from "./metrics.js";
import { installShutdown } from "./shutdown.js";
import { createAdmission } from "./admission/index.js";
const app = Fastify({
  logger: true,
  bodyLimit: 4 * 1024 * 1024,
});

const registry = new SessionRegistry(
  config.maxSessions,
  config.reattachGraceMs,
  config.idleTimeoutMs,
);
// Pool shells bypass the registry (and its reaper) entirely; they still
// count toward the max-sessions invariant via admission's capacity function.
const pool = new WarmPool(
  config.poolSize,
  () => new Session(80, 24, () => {}),
  () => registry.size,
);
const { store: admission, redis } = await createAdmission(() => registry.size + pool.reserved());

// CORS: /api/admit mutates shared admission state, so cross-origin callers
// must be allowlisted (CORS_ORIGINS). Empty keeps the dev reflect-all — a
// public deployment should always set the allowlist.
await app.register(cors,
  config.corsOrigins.length > 0
    ? {
        origin: (origin, cb) =>
          cb(null, origin !== undefined && config.corsOrigins.includes(origin)),
      }
    : { origin: true },
);
await app.register(websocket);
await app.register(wsRoutes, { registry, admission, pool });
await app.register(fileRoutes);
if (redis !== null) {
  const { brokerRoutes } = await import("./broker.js");
  await app.register(brokerRoutes, {
    redis,
    store: admission,
    capacityUsed: () => registry.size + pool.reserved(),
  });
}
app.addHook("onClose", async () => {
  pool.dispose();
  if (redis !== null) {
    // Broker onClose hook already retracted the heartbeat; close the socket.
    await redis.quit().catch(() => {});
  }
});

app.get("/api/health", async () => ({ ok: true }));

app.get("/api/metrics", async (_req, reply) => {
  reply.type("text/plain; version=0.0.4; charset=utf-8").send(render());
});

installShutdown(app, registry);
pool.fill();

await app.listen({ port: config.port, host: config.host });
