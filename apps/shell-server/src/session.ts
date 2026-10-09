import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type IPty } from "node-pty";
import { boxExecFlags, config } from "./config.js";
import { killStrays } from "./box.js";
import { leaseUid, releaseUid } from "./uid.js";
import { SPAWN_BUCKETS_MS, incCounter, observeHistogram, setGauge } from "./metrics.js";

/** Module-level so the gauge survives registry map churn between create/exit. */
let liveSessions = 0;

/**
 * One Session = one bwrap jail inside the persistent shell box, one node-pty
 * wrapping its `docker exec`. Each jail runs under a leased uid with its own
 * pid/ipc/mount namespaces and throwaway home+tmp; the session's uid is
 * swept for strays and released when the shell exits.
 */
export class Session {
  readonly id = randomUUID();
  /** Bearer proof `attach` must present — knowing the id alone grants nothing. */
  readonly secret = randomBytes(32).toString("base64url");
  readonly createdAt = Date.now();
  lastActivity = Date.now();
  exitCode: number | null = null;
  exited = false;
  /** Fairness key of the creating client, for admission accounting. */
  visitorId: string | null = null;
  /** The box uid this session's jail runs as; released after stray-sweep. */
  readonly jailUid = leaseUid();
  /** When the warm pool took this session in; null once handed out. */
  pooledAt: number | null = null;
  /** Set by the warm pool: fires when the shell dies while still pooled. */
  onPooledExit: (() => void) | null = null;

  private pty: IPty;
  private cols: number;
  private rows: number;
  /**
   * Registry cleanup on shell exit — wired at construction and re-wired by
   * `SessionRegistry.adopt` when the warm pool hands the session out, so the
   * handout gets the same delete + `onSessionEnd` path as a cold create.
   */
  private exitFinalizer: (session: Session) => void;
  /** Set on the first PTY output — measures real shell readiness (zsh boot). */
  private firstOutputAt: number | null = null;
  /** WS currently bound to this session, if any. */
  private socket: {
    send: (data: Buffer) => void;
    close: (code: number, reason: string) => void;
    readyState: number;
  } | null = null;
  /** PTY output log (ring buffer). Replayed whole on a fresh-page attach. */
  private log: Buffer[] = [];
  private logBytes = 0;
  /** Cumulative bytes trimmed off the front of `log` by the cap. */
  private droppedBytes = 0;
  /** Cumulative log bytes already flushed to an attached client. */
  private deliveredBytes = 0;
  private static readonly BACKLOG_CAP = 256 * 1024;

  constructor(cols: number, rows: number, onExit: (session: Session) => void) {
    this.cols = cols;
    this.rows = rows;
    this.exitFinalizer = onExit;
    this.pty = spawn("docker", boxExecFlags(this.jailUid), {
      name: "xterm-256color",
      cols,
      rows,
      cwd: config.contentDir,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
    });

    setGauge("sessions_active", ++liveSessions);
    this.pty.onData((data) => {
      if (this.firstOutputAt === null) {
        this.firstOutputAt = Date.now();
        observeHistogram(
          "spawn_ready_ms",
          "Time from container spawn to first PTY output (shell boot cost)",
          SPAWN_BUCKETS_MS,
          this.firstOutputAt - this.createdAt,
        );
      }
      this.pushOutput(Buffer.from(data, "utf8"));
    });
    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode ?? null;
      setGauge("sessions_active", --liveSessions);
      incCounter("session_exits_total");
      // Sweep the uid for processes the dead exec client may have orphaned
      // inside the box, then return it to the free list — release only after
      // the sweep so a recycled uid can never inherit a live process.
      void killStrays(this.jailUid).then(() => releaseUid(this.jailUid));
      this.onPooledExit?.();
      this.exitFinalizer(this);
    });
  }

  /** Warm-pool handout: hand exit cleanup over to the adopting registry. */
  wireExit(finalizer: (session: Session) => void): void {
    this.exitFinalizer = finalizer;
  }

  /**
   * Bind a socket and catch it up. `replay` flushes the whole output log —
   * a freshly loaded page reattaching with an empty xterm buffer rebuilds
   * the screen and scrollback (the welcome banner included) from the raw
   * byte stream. Without it only the disconnect gap is flushed: an in-page
   * reconnect still holds everything before the gap, and a double flush
   * would duplicate it. Warm-pool handouts count as the first attach: the
   * banner they booted with sits at log start, `deliveredBytes` is 0, and
   * the non-replay flush delivers exactly that.
   */
  attach(
    socket: {
      send: (data: Buffer) => void;
      close: (code: number, reason: string) => void;
      readyState: number;
    },
    opts: { replay?: boolean } = {},
  ): void {
    // Supersede the previous holder so a late attacher can't keep writing
    // stdin as a ghost. The wrapper's close() implementation must null its
    // connection's state.session synchronously — the socket's late 'close'
    // event then sees null and cannot detach us from the *incoming* binding.
    this.socket?.close(4409, "superseded");
    this.socket = socket;
    const start = opts.replay
      ? this.droppedBytes
      : Math.max(this.deliveredBytes, this.droppedBytes);
    let offset = this.droppedBytes;
    for (const chunk of this.log) {
      const end = offset + chunk.length;
      if (end > start) {
        socket.send(end - offset === chunk.length ? chunk : chunk.subarray(start - offset));
      }
      offset = end;
    }
    this.deliveredBytes = offset;
  }

  detach(): void {
    this.socket = null;
    this.detachedAt = Date.now();
  }

  detachedAt: number | null = null;

  get hasSocket(): boolean {
    return this.socket !== null;
  }

  write(data: Buffer): void {
    this.lastActivity = Date.now();
    if (this.exited) return;
    this.pty.write(data.toString("utf8"));
  }

  /**
   * Emit a server notice into the terminal output stream (replay log and
   * live socket included) WITHOUT feeding it to the shell — write() here
   * would type the notice as shell input and execute it.
   */
  notice(text: string): void {
    this.pushOutput(Buffer.from(text));
  }

  resize(cols: number, rows: number): void {
    // The exec client's pty dies with the shell; a resize (or write) racing
    // the exit event would otherwise throw EBADF straight through the ws
    // handler and take the server down.
    if (this.exited || cols <= 0 || rows <= 0) return;
    try {
      this.cols = cols;
      this.rows = rows;
      this.pty.resize(cols, rows);
    } catch {
      // exited between the check and the ioctl
    }
  }

  /**
   * Force a SIGWINCH so the shell repaints the screen. On reattach the
   * backlog is empty (the previous socket already drained it) and a fresh
   * xterm would otherwise sit on a blank/"starting shell…" screen until some
   * incidental resize happens to fire. Same-size resizes are usually
   * dropped by the kernel, so shrink one row and restore — zle, fzf & co.
   * all repaint on WINCH. The restore must be delayed: SIGWINCH coalesces,
   * and two immediate resizes read as "size never changed" to the shell.
   */
  nudge(): void {
    if (this.exited || this.rows <= 1) return;
    try {
      this.pty.resize(this.cols, this.rows - 1);
    } catch {
      return;
    }
    const restore = setTimeout(() => {
      if (!this.exited) {
        try {
          this.pty.resize(this.cols, this.rows);
        } catch {
          // shell exited mid-restore
        }
      }
    }, 50);
    restore.unref();
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  kill(): void {
    if (this.exited) return;
    incCounter("session_kills_total");
    try {
      this.pty.kill();
    } catch {
      // fd already gone — the exit event lands momentarily
    }
  }

  warned = false;

  private pushOutput(chunk: Buffer): void {
    this.log.push(chunk);
    this.logBytes += chunk.length;
    while (this.logBytes > Session.BACKLOG_CAP && this.log.length > 1) {
      const dropped = this.log.shift()!;
      this.logBytes -= dropped.length;
      this.droppedBytes += dropped.length;
    }
    if (this.socket) {
      this.socket.send(chunk);
      this.deliveredBytes = this.droppedBytes + this.logBytes;
    }
  }
}

/**
 * Saturation-shrinking timeouts: at ≤50% utilization the configured maxima
 * apply unchanged; as the pool fills, grace and idle tighten toward the
 * configured floors so pressure drains sessions faster. Pure — unit-testable.
 */
export function effectiveTimeouts(
  bound: number,
  max: number,
  maxGraceMs: number,
  minGraceMs: number,
  maxIdleMs: number,
  minIdleMs: number,
): { graceMs: number; idleMs: number } {
  const u = max > 0 ? bound / max : 0;
  const k = Math.min(1, Math.max(0, (u - 0.5) / 0.5));
  const lerp = (hi: number, lo: number) => Math.round(hi + (lo - hi) * k);
  return { graceMs: lerp(maxGraceMs, minGraceMs), idleMs: lerp(maxIdleMs, minIdleMs) };
}

/**
 * Owns all live sessions and the reaper loop:
 * - detached sessions die after the reattach grace window,
 * - idle sessions get a warning, then a 60s stay of execution.
 */
export class SessionRegistry {  private sessions = new Map<string, Session>();
  private timer: NodeJS.Timeout;
  /**
   * Set by the ws layer: fires once per session end (shell exit), after the
   * map delete. The single decrement path for admission accounting.
   */
  onSessionEnd: ((session: Session) => void) | null = null;

  constructor(
    private readonly maxSessions: number,
    private readonly reattachGraceMs: number,
    private readonly idleTimeoutMs: number,
  ) {
    this.timer = setInterval(() => this.reap(), 10_000);
    this.timer.unref();
  }

  get size(): number {
    return this.sessions.size;
  }

  create(cols: number, rows: number): Session {
    const session = new Session(cols, rows, (s) => {
      this.sessions.delete(s.id);
      this.onSessionEnd?.(s);
    });
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * Register a warm-pool handout. Pooled shells live outside the registry
   * (reaper-invisible by construction) until handed out; adoption gives
   * them the exact cleanup `create` uses, so reattach, reaping and the
   * admission release all apply from here on.
   */
  adopt(session: Session): void {
    session.wireExit((s) => {
      this.sessions.delete(s.id);
      this.onSessionEnd?.(s);
    });
    this.sessions.set(session.id, session);
  }

  private reap(): void {
    const now = Date.now();
    const { graceMs, idleMs } = effectiveTimeouts(
      this.sessions.size,
      config.maxSessions,
      this.reattachGraceMs,
      config.minReattachGraceMs,
      this.idleTimeoutMs,
      config.minIdleTimeoutMs,
    );
    for (const session of this.sessions.values()) {
      if (session.exited) {
        this.sessions.delete(session.id);
        continue;
      }
      const detachedFor = session.detachedAt === null ? 0 : now - session.detachedAt;
      if (!session.hasSocket && detachedFor > graceMs) {
        session.kill();
        continue;
      }
      const idleFor = now - session.lastActivity;
      if (idleFor > idleMs && !session.warned) {
        session.warned = true;
        session.notice("\r\n\x1b[33m[shell-server] idle timeout in 60s — press any key to keep the session\x1b[0m\r\n");
      } else if (session.warned && idleFor > idleMs + 60_000) {
        session.kill();
      }
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const session of this.sessions.values()) session.kill();
  }
}
