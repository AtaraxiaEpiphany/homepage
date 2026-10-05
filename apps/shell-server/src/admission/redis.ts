import { randomUUID } from "node:crypto";
import type { RedisClientType } from "redis";
import type {
  AcquireVerdict,
  AdmissionStore,
  QueueHandle,
  QueueOutcome,
  RedeemResult,
} from "./types.js";
import { incCounter, setGauge } from "../metrics.js";

/** Keys (prefix per the broker design): */
const QUEUE_KEY = "hp:queue";
const TICKET_KEY = (t: string): string => `hp:ticket:${t}`;
const VISITOR_KEY = (v: string): string => `hp:visitor:${v}`;
const HOSTS_KEY = "hp:hosts";

/**
 * TTL of a ticket in the `queued` state. Matches the memory store's queue
 * timeout so both stores time a wait out identically; expired tickets are
 * skipped by the drain and vanish on their own.
 */
const QUEUED_TTL_MS = 120_000;
/** TTL of a `granted`/`admitted` ticket — the client should redeem promptly. */
const GRANT_TTL_MS = 30_000;
/** How often a host's presence in `hp:hosts` is refreshed (see broker.ts). */
export const HEARTBEAT_MS = 5_000;
/** A host whose heartbeat is older than this is treated as gone. */
export const HOST_STALE_MS = 15_000;
/** Live-session counters self-heal (dead hosts leak them) after this. */
const VISITOR_TTL_SEC = 3_600;

interface TicketJson {
  /** "queued" while waiting; "granted"/"admitted" once a slot is reserved. */
  s: "queued" | "granted" | "admitted";
  /** Visitor the budget is charged under (null = exempt). */
  v: string | null;
  /**
   * Host owning the waiter, for tickets enqueued by a WS-pinned old client:
   * only that host can complete it (its `granted()` promise resolves a local
   * connection). HTTP preflight tickets carry null and any host may grant.
   */
  p: string | null;
  /** WS base URL the client should connect to (null = same public origin). */
  u: string | null;
}

/**
 * Pop tickets off the queue while the calling host has room.
 *
 * Per ticket: expired/canceled tickets are dropped; tickets whose visitor is
 * over budget or whose waiter is pinned to another host rotate to the tail
 * (same policy as the memory store's drain); a ticket pinned to THIS host is
 * consumed and returned in `mine` — the node resolves its local waiter; an
 * unpinned ticket is marked `granted` (with this host's URL) for the HTTP
 * client polling /api/queue/:ticket.
 *
 * The `scanned` counter stops after one full rotation of ungrantable tickets,
 * mirroring MemoryAdmission.drain. Returns [servedCount, ...mineTickets].
 */
const DRAIN_LUA = `
local me = ARGV[1]
local visitorMax = tonumber(ARGV[2])
local grantTtl = ARGV[3]
local url = ARGV[4]
local mine = {}
local served = 0
local scanned = 0
while scanned < redis.call('LLEN', KEYS[1]) do
  local t = redis.call('LPOP', KEYS[1])
  if not t then break end
  local raw = redis.call('GET', 'hp:ticket:' .. t)
  if not raw then
    scanned = scanned + 1
  else
    local ok, tk = pcall(cjson.decode, raw)
    if not ok then
      scanned = scanned + 1
    else
      local v, p = tk.v, tk.p
      if v == cjson.null then v = nil end
      if p == cjson.null then p = nil end
      local blocked = false
      if v and tonumber(redis.call('GET', 'hp:visitor:' .. v) or '0') >= visitorMax then
        blocked = true
      end
      if blocked or (p and p ~= me) then
        redis.call('RPUSH', KEYS[1], t)
        scanned = scanned + 1
      elseif p == me then
        table.insert(mine, t)
        scanned = 0
      else
        local gj = cjson.encode({s = 'granted', v = v, u = url})
        if redis.call('SET', 'hp:ticket:' .. t, gj, 'PX', grantTtl, 'NX') then
          served = served + 1
          scanned = 0
        else
          scanned = scanned + 1
        end
      end
    end
  end
end
return {served, unpack(mine)}
`;

interface LocalWaiter {
  ticket: string;
  visitorId: string | null;
  resolve: ((outcome: QueueOutcome) => void) | null;
  timer: NodeJS.Timeout | null;
  /** Cached 1-based position; refreshed by the tick via LPOS. */
  lastPos: number;
}

/**
 * Redis-backed admission for broker mode. Capacity is enforced per host
 * (the local hard cap, read live) — hosts never grant slots on another
 * host's behalf. The queue is the one shared structure: any host with
 * headroom drains it for itself, marking tickets with its own URL, so
 * saturated hosts naturally spill visitors to whoever has room.
 *
 * Fail-safe: when redis is unreachable, tryAcquire rejects with server_full
 * (fail closed — no admission without shared state) and the WS create path
 * surfaces it; everything else degrades quietly.
 */
export class RedisAdmission implements AdmissionStore {
  /** Waiters pinned to this process (WS-connected old clients). */
  private local = new Map<string, LocalWaiter>();
  private depthListeners: Array<() => void> = [];
  private lastDepth = 0;
  private disposed = false;
  private ticker: NodeJS.Timeout;

  constructor(
    private readonly redis: RedisClientType,
    private readonly maxSessions: number,
    private readonly capacityUsed: () => number,
    private readonly visitorMaxSessions: number,
    private readonly queueMax: number,
    private readonly queueTimeoutMs: number,
    private readonly hostId: string,
    private readonly hostPublicUrl: string | null,
  ) {
    this.ticker = setInterval(() => void this.tick(), 1_000);
    this.ticker.unref();
  }

  async tryAcquire(visitorId: string | null): Promise<AcquireVerdict> {
    try {
      if (visitorId !== null) {
        const used = Number((await this.redis.get(VISITOR_KEY(visitorId))) ?? "0");
        if (used >= this.visitorMaxSessions) {
          return { verdict: "reject", code: "visitor_limit" };
        }
      }
      if (this.capacityUsed() < this.maxSessions) {
        // Authoritative budget check: INCR is atomic across hosts; refund if
        // another host won the race past the cap.
        if (visitorId === null || (await this.chargeVisitor(visitorId))) {
          return { verdict: "admit" };
        }
        return { verdict: "reject", code: "visitor_limit" };
      }
      if ((await this.redis.lLen(QUEUE_KEY)) < this.queueMax) {
        return { verdict: "queue" };
      }
      return { verdict: "reject", code: "queue_full" };
    } catch (err) {
      logRedisError(err, "tryAcquire");
      return { verdict: "reject", code: "server_full" };
    }
  }

  async enqueue(visitorId: string | null): Promise<QueueHandle> {
    const ticket = randomUUID();
    const entry: LocalWaiter = { ticket, visitorId, resolve: null, timer: null, lastPos: 0 };
    const t: TicketJson = { s: "queued", v: visitorId, p: this.hostId, u: this.hostPublicUrl };
    await this.redis.rPush(QUEUE_KEY, ticket);
    await this.redis.set(TICKET_KEY(ticket), JSON.stringify(t), { PX: QUEUED_TTL_MS });
    this.local.set(ticket, entry);
    this.publishDepth(await this.redis.lLen(QUEUE_KEY));
    const handle: QueueHandle = {
      ticket,
      position: () => entry.lastPos,
      granted: () =>
        new Promise<QueueOutcome>((resolve) => {
          if (entry.resolve !== null) {
            resolve("canceled");
            return;
          }
          entry.resolve = resolve;
          // The tick may already have granted/settled this entry before the
          // WS route registered interest.
          if (!this.local.has(ticket)) {
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
    void this.redis
      .decr(VISITOR_KEY(visitorId))
      .then((n) => {
        // Floor at zero: a dead host's leaked counter must not go negative
        // and eat a live visitor's budget forever.
        if (n < 0) {
          return this.redis
            .set(VISITOR_KEY(visitorId), "0", { EX: VISITOR_TTL_SEC })
            .then(() => undefined);
        }
      })
      .catch((err) => logRedisError(err, "release"));
  }

  queueDepth(): number {
    return this.lastDepth;
  }

  onDepthChange(cb: () => void): void {
    this.depthListeners.push(cb);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.ticker);
    for (const entry of [...this.local.values()]) this.settle(entry, "canceled");
    this.publishDepth(0);
  }

  async redeemTicket(ticket: string): Promise<RedeemResult> {
    const invalid: RedeemResult = { outcome: "invalid", ticket };
    let raw: string | null;
    try {
      raw = await this.redis.getDel(TICKET_KEY(ticket));
    } catch (err) {
      logRedisError(err, "redeemTicket");
      return invalid;
    }
    if (!raw) return invalid;
    let t: TicketJson;
    try {
      t = JSON.parse(raw) as TicketJson;
    } catch {
      return invalid;
    }
    if (t.s !== "queued" && t.s !== "granted" && t.s !== "admitted") return invalid;
    const visitorId = t.v ?? null;
    const verdict = await this.tryAcquire(visitorId);
    if (verdict.verdict !== "admit") {
      // The slot reserved at grant time was taken meanwhile (a local create
      // slipped in). Restore the ticket so the caller keeps its queue spot.
      await this.restoreTicket(ticket, visitorId);
    }
    return { outcome: "valid", verdict, ticket, visitorId };
  }
  /**
   * Drain when this host has headroom; resolve local waiters for tickets it
   * owned. Called by the 1s tick — also the path that turns a remote host's
   * saturation into a grant on THIS host.
   */
  private async drainQueue(): Promise<void> {
    const res = (await this.redis.eval(DRAIN_LUA, {
      keys: [QUEUE_KEY],
      arguments: [
        this.hostId,
        String(this.visitorMaxSessions),
        String(GRANT_TTL_MS),
        this.hostPublicUrl ?? "",
      ],
    })) as unknown[];
    const served = Number(res[0] ?? 0);
    const mine = res.slice(1) as string[];
    if (served > 0) incCounter("queue_grants_total", { kind: "remote" }, served);
    for (const ticket of mine) {
      const entry = this.local.get(ticket);
      if (!entry) {
        // Waiter gone between enqueue and grant (raced with cancel/cleanup).
        await this.redis.del(TICKET_KEY(ticket));
        continue;
      }
      if (await this.chargeVisitor(entry.visitorId)) {
        this.settle(entry, "granted");
        incCounter("queue_grants_total", { kind: "local" });
      } else {
        // Budget vanished while queued — rotate back, like the memory store.
        await this.restoreTicket(ticket, entry.visitorId);
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    try {
      for (const entry of this.local.values()) {
        const idx = await this.redis.lPos(QUEUE_KEY, entry.ticket);
        const pos = idx === null || idx === undefined ? 0 : idx + 1;
        if (pos !== entry.lastPos) {
          entry.lastPos = pos;
          this.fireDepth();
        }
      }
      if (this.capacityUsed() < this.maxSessions) await this.drainQueue();
      const len = await this.redis.lLen(QUEUE_KEY);
      this.publishDepth(len);
    } catch (err) {
      logRedisError(err, "tick");
    }
  }

  /** Charge one session to a visitor, atomically capped. */
  private async chargeVisitor(visitorId: string | null): Promise<boolean> {
    if (visitorId === null) return true;
    const n = await this.redis.incr(VISITOR_KEY(visitorId));
    if (n > this.visitorMaxSessions) {
      await this.redis.decr(VISITOR_KEY(visitorId));
      return false;
    }
    // Self-heal: a host that dies without refunding must not lock the
    // visitor out forever; sessions never outlive their idle reaper.
    await this.redis.expire(VISITOR_KEY(visitorId), VISITOR_TTL_SEC);
    return true;
  }

  private async restoreTicket(ticket: string, visitorId: string | null): Promise<void> {
    const t: TicketJson = { s: "queued", v: visitorId, p: this.hostId, u: this.hostPublicUrl };
    await this.redis.set(TICKET_KEY(ticket), JSON.stringify(t), { PX: QUEUED_TTL_MS });
    await this.redis.rPush(QUEUE_KEY, ticket);
  }

  /**
   * Local settle: remove the waiter and resolve `granted()`. Redis cleanup
   * is best-effort (lRem/del no-op for already-consumed tickets).
   */
  private settle(entry: LocalWaiter, outcome: QueueOutcome): void {
    if (!this.local.delete(entry.ticket)) return;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.resolve?.(outcome);
    entry.resolve = null;
    if (outcome !== "granted") {
      void this.redis.lRem(QUEUE_KEY, 1, entry.ticket).catch((err) => logRedisError(err, "settle"));
      void this.redis.del(TICKET_KEY(entry.ticket)).catch((err) => logRedisError(err, "settle"));
    }
    this.fireDepth();
  }

  private publishDepth(depth: number): void {
    if (depth !== this.lastDepth) {
      this.lastDepth = depth;
      setGauge("queue_depth", depth);
      this.fireDepth();
    }
  }

  private fireDepth(): void {
    for (const cb of this.depthListeners) cb();
  }
}

let lastErrorLogAt = 0;

function logRedisError(err: unknown, where: string): void {
  incCounter("redis_errors_total", { op: where });
  // Throttle: a down redis fires the 1s tick — one line per 10s is plenty.
  const now = Date.now();
  if (now - lastErrorLogAt > 10_000) {
    lastErrorLogAt = now;
    console.error(`[admission] redis ${where} failed (further errors throttled):`, err);
  }
}

/** Presence-record shape stored under HOSTS_KEY (written by broker.ts). */
export interface HostRecord {
  url: string | null;
  bound: number;
  max: number;
  ts: number;
}

export { HOSTS_KEY, TICKET_KEY, VISITOR_KEY, QUEUE_KEY };
