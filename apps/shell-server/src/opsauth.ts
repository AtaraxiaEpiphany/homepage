import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

/**
 * timingSafeEqual throws on length mismatches, and attacker-supplied strings
 * are arbitrary — compare fixed-size SHA-256 digests instead (same shape as
 * the WS first-frame check in ws.ts).
 */
const safeEqual = (a: string, b: string): boolean =>
  timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );

/**
 * Gate for the ops-only endpoints (/api/hosts, /api/metrics): they disclose
 * topology (host ids, grant endpoints, live load) and operational counters,
 * so they are never part of the public client surface. Callers present the
 * shared secret as `Authorization: Bearer <OPS_TOKEN>`; unset, it falls back
 * to WS_TOKEN so token-mode deployments are gated without extra config. No
 * secret configured at all = the dev posture (loopback-only server), where
 * the data plane is equally open.
 */
export const opsGuard: preHandlerHookHandler = async (request: FastifyRequest, reply: FastifyReply) => {
  const expected = config.opsToken;
  if (expected === "") return;
  const got = request.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
  if (got === "" || !safeEqual(got, expected)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
};
