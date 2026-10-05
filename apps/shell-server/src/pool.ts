import { config } from "./config.js";
import { Session } from "./session.js";
import { incCounter, setGauge } from "./metrics.js";

/**
 * Warm pool: pre-spawned, never-bound sessions handed out synchronously on
 * create so a fresh tab skips the zsh/docker boot. Design constraints:
 *
 * - Pool shells live OUTSIDE the SessionRegistry — the reaper never sees
 *   them, so they are exempt from idle/detached reaping by construction.
 *   A TTL sweeper churns them instead, bounding stale shells.
 * - They still count toward MAX_SESSIONS (same docker CLI process, same
 *   tmpfs, same caps as a bound session). The invariant is
 *   bound + ready + inFlight <= maxSessions, and the admission store's
 *   capacity function includes `reserved()` so the slot formula lives in
 *   one place.
 * - Handout is terminal: a pooled container is handed out at most once,
 *   then it is an ordinary session. No reuse, no cross-visitor tmpfs.
 */
export class WarmPool {
  private ready: Session[] = [];
  private inFlight = 0;
  private disposed = false;
  private timer: NodeJS.Timeout;

  constructor(
    private readonly size: number,
    private readonly spawn: () => Session,
    private readonly boundCount: () => number,
  ) {
    this.timer = setInterval(() => this.sweepTtl(), 30_000);
    this.timer.unref();
  }

  /** Total slots spoken for: ready shells plus spawns in progress. */
  reserved(): number {
    return this.ready.length + this.inFlight;
  }

  /** Spawn toward the target while the max-sessions invariant allows. */
  fill(): void {
    if (this.disposed) return;
    while (
      !this.disposed &&
      this.ready.length + this.inFlight < this.size &&
      this.boundCount() + this.reserved() < config.maxSessions
    ) {
      this.inFlight += 1;
      try {
        const session = this.spawn();
        session.pooledAt = Date.now();
        session.onPooledExit = () => {
          // Died while waiting (docker gone, OOM): drop and refill.
          this.ready = this.ready.filter((s) => s !== session);
          this.publish();
          this.fillAsync();
        };
        this.ready.push(session);
        incCounter("pool_spawns_total");
      } catch (err) {
        // Spawn failure must never take the server down — the cold path in
        // finishCreate still answers creates; retry on the next fill().
        incCounter("pool_spawn_failures_total");
        console.error("[pool] spawn failed:", err);
        this.inFlight -= 1;
        break;
      }
      this.inFlight -= 1;
    }
    this.publish();
  }

  /** Pop a warm shell, or null when empty (caller falls back to cold spawn). */
  take(): Session | null {
    const session = this.ready.shift() ?? null;
    if (session !== null) {
      session.pooledAt = null;
      session.onPooledExit = null;
      incCounter("pool_handouts_total");
      this.publish();
      this.fillAsync();
    }
    return session;
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    for (const s of this.ready) {
      if (!s.exited) s.kill();
    }
    this.ready = [];
    this.publish();
  }

  private fillAsync(): void {
    setTimeout(() => this.fill(), 0);
  }

  /** Kill shells older than the TTL (or already dead) and refill. */
  private sweepTtl(): void {
    if (this.disposed) return;
    const cutoff = Date.now() - config.poolShellTtlMs;
    const kept: Session[] = [];
    let churned = 0;
    for (const s of this.ready) {
      const stale = s.pooledAt !== null && s.pooledAt < cutoff;
      if (s.exited || stale) {
        if (!s.exited) s.kill();
        churned += 1;
      } else {
        kept.push(s);
      }
    }
    this.ready = kept;
    if (churned > 0) {
      incCounter("pool_churn_total", undefined, churned);
      this.fill();
    }
    this.publish();
  }

  private publish(): void {
    setGauge("pool_ready", this.ready.length);
    setGauge("pool_inflight", this.inFlight);
  }
}
