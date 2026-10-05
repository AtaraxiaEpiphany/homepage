/**
 * Admission control: capacity check, per-visitor budget, waiting room. The
 * interface is store-agnostic: the memory store (single host) and the redis
 * store (broker mode, multi-host) are interchangeable behind ws.ts — the
 * create path reads the same either way. Methods that touch remote state are
 * async; awaiting the memory store's promises is free.
 */

export type AcquireVerdict =
  | { verdict: "admit" }
  | { verdict: "queue" }
  | { verdict: "reject"; code: "server_full" | "queue_full" | "visitor_limit" };

export type QueueOutcome = "granted" | "canceled" | "timeout";

export interface QueueHandle {
  readonly ticket: string;
  /** 1-based waiting-room position; 0 once no longer queued. */
  position(): number;
  granted(): Promise<QueueOutcome>;
  /** Leave the queue. Idempotent; resolves `granted()` with "canceled". */
  cancel(): void;
}

export type RedeemResult =
  | { outcome: "invalid"; ticket: string }
  | {
      outcome: "valid";
      verdict: AcquireVerdict;
      ticket: string;
      /** The visitor the ticket was issued to (budget is charged under it). */
      visitorId: string | null;
    };

export interface AdmissionStore {
  /**
   * Try to admit a create outright. "queue" means capacity is full but the
   * waiting room has room — follow with `enqueue`. Budget is charged here and
   * on grants, refunded by `release` (once per session end).
   */
  tryAcquire(visitorId: string | null): Promise<AcquireVerdict>;
  enqueue(visitorId: string | null): Promise<QueueHandle>;
  /** Refund one session for this visitor. Idempotent per session end. */
  release(visitorId: string | null): void;
  queueDepth(): number;
  /** Fires whenever queue membership changes — position updates fan out. */
  onDepthChange(cb: () => void): void;
  /** Settle every queued handle with "canceled" — shutdown path. */
  dispose(): void;
  /**
   * Broker mode only (undefined on the memory store): consume a preflight
   * ticket and run admission on its behalf. "invalid" = unknown, expired or
   * malformed ticket. When the verdict is not "admit" the ticket is restored
   * to the queue first, so the caller's waiting-room spot survives.
   */
  redeemTicket?(ticket: string): Promise<RedeemResult>;
}
