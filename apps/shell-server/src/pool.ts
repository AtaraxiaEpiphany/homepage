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
  /** Set by index.ts: pokes the admission queue after a shrink freed a slot. */
  onCapacityFreed: (() => void) | null = null;
  /**
   * Waiting-room depth, wired by index.ts once admission exists (the pool is
   * constructed first). A queued visitor outranks a warm spare: the shrink
   * path below sheds ready shells rather than let one hold the last slot.
   */
  queueDepth: () => number = () => 0;

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

  /**
   * Reconcile the pool toward its target: kill warm spares when waiting-room
   * visitors outrank them (a queued grant consumes a ready shell or a cold
   * spawn either way — the spare must never hold the last slot hostage),
   * spawn toward the target while the max-sessions invariant allows.
   */
  fill(): void {
    if (this.disposed) return;
    let shrunk = 0;
    while (
      this.ready.length > 0 &&
      this.boundCount() + this.reserved() + this.queueDepth() > config.maxSessions
    ) {
      const session = this.ready.pop()!;
      // Dying on purpose is not a refill signal — the shrink IS the refill
      // decision; a fresh spawn here would just re-grab the freed slot.
      session.onPooledExit = null;
      if (!session.exited) session.kill();
      shrunk += 1;
    }
    if (shrunk > 0) {
      incCounter("pool_churn_total", undefined, shrunk);
      this.publish();
      // The freed slot is invisible to the admission queue's capacity check
      // until something re-reads it — wake the waiting room now.
      this.onCapacityFreed?.();
    }
    while (
      !this.disposed &&
      this.ready.length + this.inFlight < this.size &&
      this.boundCount() + this.reserved() + this.queueDepth() < config.maxSessions
    ) {
      this.inFlight += 1;
      try {
        const session = this.spawn();
        session.pooledAt = Date.now();
        session.onPooledExit = () => {
          // Died while waiting (docker gone, OOM): drop and refill. A shell
          // that died at once means the failure is persistent (box missing,
          // image broken) — refill on a delay, or the exit→fill loop becomes
          // a tight respawn spinning on a failing docker exec.
          this.ready = this.ready.filter((s) => s !== session);
          this.publish();
          const livedMs = session.pooledAt === null ? Infinity : Date.now() - session.pooledAt;
          if (livedMs > 5_000) this.fillAsync();
          else setTimeout(() => this.fill(), 2_000).unref();
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
