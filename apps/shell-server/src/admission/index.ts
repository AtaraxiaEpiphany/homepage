import type { AdmissionStore } from "./types.js";
import { MemoryAdmission } from "./memory.js";
import { config } from "../config.js";

/**
 * Admission factory. Single-host default: the in-memory store, zero extra
 * deps. The broker phase adds a redis-backed store selected by
 * BROKER_REDIS_URL (dynamic import keeps it out of the memory-mode path).
 */
export function createAdmission(capacityUsed: () => number): AdmissionStore {
  return new MemoryAdmission(
    config.maxSessions,
    capacityUsed,
    config.visitorMaxSessions,
    config.queueMax,
    config.queueTimeoutMs,
  );
}

export type { AdmissionStore, QueueHandle, AcquireVerdict } from "./types.js";
