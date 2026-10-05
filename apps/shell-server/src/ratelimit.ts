import { config } from "./config.js";

/**
 * Per-IP abuse floor: create throttling, auth-failure lockout, concurrent-WS
 * cap. The IP is the raw socket address — never a forwarded header — so a
 * reverse proxy collapses all visitors into one bucket. That is the intent:
 * the floor stops volumetric abuse, it does not do fairness (browsers carry
 * the visitor token for that). Only auth *failures* lock out; creates merely
 * throttle, so one abuser can slow a shared bucket but never lock it closed.
 */

export interface CreateVerdict {
  ok: boolean;
  retryAfterSec: number;
}

export interface AuthFailVerdict {
  /** True when this failure crossed the threshold and locked the IP. */
  locked: boolean;
  retryAfterSec: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

interface AuthState {
  failures: number;
  lockedUntil: number;
}

const SWEEP_INTERVAL_MS = 60_000;
const BUCKET_TTL_MS = 10 * 60_000;

export function createRateLimiter(cfg: {
  createRatePerMin: number;
  createRateBurst: number;
  authMaxFailures: number;
  authLockoutMs: number;
  maxWsPerIp: number;
}) {
  const buckets = new Map<string, Bucket>();
  const auth = new Map<string, AuthState>();
  const liveWs = new Map<string, number>();

  const refill = (ip: string, now: number): Bucket => {
    let b = buckets.get(ip);
    if (!b) {
      b = { tokens: cfg.createRateBurst, updatedAt: now };
      buckets.set(ip, b);
      return b;
    }
    const elapsed = now - b.updatedAt;
    if (elapsed > 0) {
      b.tokens = Math.min(cfg.createRateBurst, b.tokens + (elapsed / 60_000) * cfg.createRatePerMin);
      b.updatedAt = now;
    }
    return b;
  };

  const limiter = {
    /** Consume one token from the IP's create bucket. */
    hitCreate(ip: string): CreateVerdict {
      const now = Date.now();
      const b = refill(ip, now);
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { ok: true, retryAfterSec: 0 };
      }
      const deficit = 1 - b.tokens;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((deficit / cfg.createRatePerMin) * 60)) };
    },

    /** Record an auth failure; tells whether the IP just became locked out. */
    hitAuthFail(ip: string): AuthFailVerdict {
      const now = Date.now();
      const s = auth.get(ip) ?? { failures: 0, lockedUntil: 0 };
      if (s.lockedUntil > now) {
        return { locked: true, retryAfterSec: Math.ceil((s.lockedUntil - now) / 1000) };
      }
      s.failures += 1;
      if (s.failures >= cfg.authMaxFailures) {
        s.lockedUntil = now + cfg.authLockoutMs;
        s.failures = 0; // after the lockout lifts, the IP starts clean
        auth.set(ip, s);
        return { locked: true, retryAfterSec: Math.ceil(cfg.authLockoutMs / 1000) };
      }
      auth.set(ip, s);
      return { locked: false, retryAfterSec: 0 };
    },

    /** Whether the IP is currently locked out (checked before reading auth frames). */
    isLockedOut(ip: string): boolean {
      const s = auth.get(ip);
      return s !== undefined && s.lockedUntil > Date.now();
    },

    lockoutRemainingSec(ip: string): number {
      const s = auth.get(ip);
      return s && s.lockedUntil > Date.now() ? Math.ceil((s.lockedUntil - Date.now()) / 1000) : 0;
    },

    /** Successful auth clears the failure streak. */
    clearAuthFailures(ip: string): void {
      const s = auth.get(ip);
      if (s) s.failures = 0;
    },

    /** Try to count one more live WS for the IP; false when at the cap. */
    wsAcquire(ip: string): boolean {
      const n = liveWs.get(ip) ?? 0;
      if (n >= cfg.maxWsPerIp) return false;
      liveWs.set(ip, n + 1);
      return true;
    },

    wsRelease(ip: string): void {
      const n = liveWs.get(ip) ?? 0;
      if (n <= 1) liveWs.delete(ip);
      else liveWs.set(ip, n - 1);
    },

    snapshot(): { ips: number; liveWsTotal: number } {
      return { ips: buckets.size + auth.size, liveWsTotal: liveWs.size };
    },
  };

  // Periodic sweep so idle buckets don't accumulate forever on a public box.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets) {
      if (now - b.updatedAt > BUCKET_TTL_MS) buckets.delete(ip);
    }
    for (const [ip, s] of auth) {
      if (s.lockedUntil <= now && s.failures === 0) auth.delete(ip);
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  return limiter;
}

export const rateLimiter = createRateLimiter(config);
