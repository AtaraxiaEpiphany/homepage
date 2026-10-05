import { randomUUID } from "node:crypto";
import type {
  AcquireVerdict,
  AdmissionStore,
  QueueHandle,
  QueueOutcome,
} from "./types.js";
import { incCounter, setGauge } from "../metrics.js";

interface QueueEntry {
  ticket: string;
  visitorId: string | null;
  resolve: ((outcome: QueueOutcome) => void) | null;
  timer: NodeJS.Timeout | null;
}

/**
 * In-memory admission: capacity + per-visitor budget + FIFO waiting room.
 * Single-host only — the broker phase swaps in the redis store with the same
 * interface. Capacity is read through `capacityUsed` (registry size today,
 * pool-aware once the warm pool exists) so the slot formula lives in exactly
 * one place.
 */
export class MemoryAdmission implements AdmissionStore {
  /** Live sessions per visitor id. */
  private perVisitor = new Map<string, number>();
  private queue: QueueEntry[] = [];
  private depthListeners: Array<() => void> = [];
  private disposed = false;

  constructor(
    private readonly maxSessions: number,
    private readonly capacityUsed: () => number,
    private readonly visitorMaxSessions: number,
    private readonly queueMax: number,
    private readonly queueTimeoutMs: number,
  ) {}

  tryAcquire(visitorId: string | null): AcquireVerdict {
    if (visitorId !== null && this.visitorUsage(visitorId) >= this.visitorMaxSessions) {
      return { verdict: "reject", code: "visitor_limit" };
    }
    if (this.capacityUsed() < this.maxSessions) {
      this.charge(visitorId);
      return { verdict: "admit" };
    }
    if (this.queue.length < this.queueMax) return { verdict: "queue" };
    return { verdict: "reject", code: "queue_full" };
  }

  enqueue(visitorId: string | null): QueueHandle {
    const entry: QueueEntry = {
      ticket: randomUUID(),
      visitorId,
      resolve: null,
      timer: null,
    };
    this.queue.push(entry);
    this.publishDepth();
    const handle: QueueHandle = {
      ticket: entry.ticket,
      position: () => this.positionOf(entry),
      granted: () =>
        new Promise<QueueOutcome>((resolve) => {
          if (entry.resolve !== null) {
            // granted() already resolved elsewhere — settle immediately.
            resolve("canceled");
            return;
          }
          entry.resolve = resolve;
          // The waiter promise exists only after ws.ts registers interest;
          // the entry may already have been granted/removed.
          if (!this.queue.includes(entry)) {
            resolve("granted");
            entry.resolve = null;
            return;
          }
          entry.timer = setTimeout(() => this.settle(entry, "timeout"), this.queueTimeoutMs);
          entry.timer.unref();
        }),
      cancel: () => this.settle(entry, "canceled"),
    };
    return handle;
  }

  release(visitorId: string | null): void {
    if (visitorId === null) return;
    const n = this.perVisitor.get(visitorId) ?? 0;
    if (n <= 1) this.perVisitor.delete(visitorId);
    else this.perVisitor.set(visitorId, n - 1);
    this.drain();
  }

  queueDepth(): number {
    return this.queue.length;
  }

  onDepthChange(cb: () => void): void {
    this.depthListeners.push(cb);
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of [...this.queue]) this.settle(entry, "canceled");
    this.publishDepth();
  }

  /**
   * Grant head-of-line entries while capacity lasts. A visitor whose budget
   * vanished while queued (another tab won the race) rotates to the tail so
   * later entries pass; a full rotation means nobody is grantable.
   */
  private drain(): void {
    if (this.disposed) return;
    let scanned = 0;
    while (
      this.queue.length > 0 &&
      scanned < this.queue.length &&
      this.capacityUsed() < this.maxSessions
    ) {
      const entry = this.queue[0]!;
      if (
        entry.visitorId !== null &&
        this.visitorUsage(entry.visitorId) >= this.visitorMaxSessions
      ) {
        this.queue.push(this.queue.shift()!);
        scanned += 1;
        continue;
      }
      this.queue.shift();
      this.clearTimer(entry);
      this.charge(entry.visitorId);
      incCounter("queue_grants_total");
      entry.resolve?.("granted");
      entry.resolve = null;
      this.publishDepth();
      scanned = 0;
    }
  }

  private settle(entry: QueueEntry, outcome: QueueOutcome): void {
    const idx = this.queue.indexOf(entry);
    if (idx >= 0) this.queue.splice(idx, 1);
    this.clearTimer(entry);
    entry.resolve?.(outcome);
    entry.resolve = null;
    if (idx >= 0) this.publishDepth();
  }

  private positionOf(entry: QueueEntry): number {
    const idx = this.queue.indexOf(entry);
    return idx < 0 ? 0 : idx + 1;
  }

  private clearTimer(entry: QueueEntry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  private visitorUsage(visitorId: string | null): number {
    return visitorId === null ? 0 : (this.perVisitor.get(visitorId) ?? 0);
  }

  private charge(visitorId: string | null): void {
    if (visitorId === null) return;
    this.perVisitor.set(visitorId, this.visitorUsage(visitorId) + 1);
  }

  private publishDepth(): void {
    setGauge("queue_depth", this.queue.length);
    for (const cb of this.depthListeners) cb();
  }
}
