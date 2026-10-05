import type { RedisClientType } from "redis";
import type { AdmissionStore } from "./types.js";
import { MemoryAdmission } from "./memory.js";
import { config } from "../config.js";

export interface AdmissionComponents {
  store: AdmissionStore;
  /** Non-null in broker mode — broker.ts shares the connection. */
  redis: RedisClientType | null;
}

/**
 * Admission factory. Single-host default: the in-memory store, zero extra
 * deps. BROKER_REDIS_URL selects the redis-backed store (dynamic import keeps
 * the client out of the memory-mode path) and hands the connection back for
 * the broker endpoints.
 */
export async function createAdmission(capacityUsed: () => number): Promise<AdmissionComponents> {
  if (config.brokerRedisUrl !== "") {
    const { createClient } = await import("redis");
    const redis = createClient({ url: config.brokerRedisUrl });
    await redis.connect();
    const { RedisAdmission } = await import("./redis.js");
    return {
      store: new RedisAdmission(
        redis,
        config.maxSessions,
        capacityUsed,
        config.visitorMaxSessions,
        config.queueMax,
        config.queueTimeoutMs,
        config.hostId,
        config.hostPublicUrl === "" ? null : config.hostPublicUrl,
      ),
      redis,
    };
  }
  return {
    store: new MemoryAdmission(
      config.maxSessions,
      capacityUsed,
      config.visitorMaxSessions,
      config.queueMax,
      config.queueTimeoutMs,
    ),
    redis: null,
  };
}

export type { AdmissionStore, QueueHandle, AcquireVerdict, RedeemResult } from "./types.js";
