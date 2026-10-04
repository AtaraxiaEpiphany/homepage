import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { wsRoutes } from "./ws.js";
import { fileRoutes } from "./files.js";

const app = Fastify({
  logger: true,
  bodyLimit: 4 * 1024 * 1024,
});

await app.register(cors, { origin: true });
await app.register(websocket);
await app.register(wsRoutes);
await app.register(fileRoutes);

app.get("/api/health", async () => ({ ok: true }));

await app.listen({ port: config.port, host: config.host });
