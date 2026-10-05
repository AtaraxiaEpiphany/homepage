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
const admission = createAdmission(() => registry.size + pool.reserved());

await app.register(cors, { origin: true });
await app.register(websocket);
await app.register(wsRoutes, { registry, admission, pool });
await app.register(fileRoutes);
app.addHook("onClose", async () => pool.dispose());

app.get("/api/health", async () => ({ ok: true }));

app.get("/api/metrics", async (_req, reply) => {
  reply.type("text/plain; version=0.0.4; charset=utf-8").send(render());
});

installShutdown(app, registry);
pool.fill();

await app.listen({ port: config.port, host: config.host });
