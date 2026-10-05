import type { FastifyInstance } from "fastify";
import type { SessionRegistry } from "./session.js";
import { config } from "./config.js";

let draining = false;

/** True once a shutdown signal landed — new sessions are refused while draining. */
export const isDraining = (): boolean => draining;

/**
 * SIGTERM/SIGINT lifecycle: refuse new sessions, stop accepting connections,
 * let live shells drain until the registry empties or the budget expires, then
 * dispose (kills leftovers) and exit 0. A second signal exits immediately.
 */
export function installShutdown(app: FastifyInstance, registry: SessionRegistry): void {
  let announced = false;
  const drain = (signal: string) => {
    if (announced) {
      app.log.warn({ signal }, "second signal — exiting immediately");
      process.exit(1);
    }
    announced = true;
    draining = true;
    app.log.info({ signal }, "draining: refusing new sessions");
    // Stop accepting new connections; live sockets (WS included) keep draining.
    app.server.closeIdleConnections?.();
    app.server.close();
    const deadline = Date.now() + config.drainTimeoutMs;
    const poll = setInterval(() => {
      if (registry.size > 0 && Date.now() < deadline) return;
      clearInterval(poll);
      if (registry.size > 0) {
        app.log.info({ left: registry.size }, "drain budget spent — killing leftover sessions");
      }
      // onClose hooks dispose the registry; exit code 0 either way.
      app.close().finally(() => process.exit(0));
    }, 250);
    poll.unref();
  };

  process.on("SIGTERM", () => drain("SIGTERM"));
  process.on("SIGINT", () => drain("SIGINT"));
}
