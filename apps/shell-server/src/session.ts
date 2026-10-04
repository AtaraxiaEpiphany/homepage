import { randomUUID } from "node:crypto";
import { spawn, type IPty } from "node-pty";
import { DOCKER_RUN_FLAGS, config } from "./config.js";

/**
 * One Session = one ephemeral `docker run` of the shell image, one node-pty.
 * Resource limits apply per session; zsh exiting tears the container down
 * (--rm) so nothing accumulates across sessions.
 */
export class Session {
  readonly id = randomUUID();
  readonly createdAt = Date.now();
  lastActivity = Date.now();
  exitCode: number | null = null;
  exited = false;

  private pty: IPty;
  private cols: number;
  private rows: number;
  /** WS currently bound to this session, if any. */
  private socket: {
    send: (data: Buffer) => void;
    close: (code: number, reason: string) => void;
    readyState: number;
  } | null = null;
  /** PTY output buffered while no socket is attached (reattach gap). */
  private backlog: Buffer[] = [];
  private backlogBytes = 0;
  private static readonly BACKLOG_CAP = 256 * 1024;

  constructor(cols: number, rows: number, onExit: (session: Session) => void) {
    this.cols = cols;
    this.rows = rows;
    this.pty = spawn("docker", DOCKER_RUN_FLAGS, {
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

    this.pty.onData((data) => this.pushOutput(Buffer.from(data, "utf8")));
    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode ?? null;
      onExit(this);
    });
  }

  attach(socket: {
    send: (data: Buffer) => void;
    close: (code: number, reason: string) => void;
    readyState: number;
  }): void {
    // Supersede the previous holder so a late attacher can't keep writing
    // stdin as a ghost. The wrapper's close() implementation must null its
    // connection's state.session synchronously — the socket's late 'close'
    // event then sees null and cannot detach us from the *incoming* binding.
    this.socket?.close(4409, "superseded");
    this.socket = socket;
    for (const chunk of this.backlog) socket.send(chunk);
    this.backlog = [];
    this.backlogBytes = 0;
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
    this.pty.write(data.toString("utf8"));
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) {
      this.cols = cols;
      this.rows = rows;
      this.pty.resize(cols, rows);
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
    this.pty.resize(this.cols, this.rows - 1);
    const restore = setTimeout(() => {
      if (!this.exited) this.pty.resize(this.cols, this.rows);
    }, 50);
    restore.unref();
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  kill(): void {
    if (this.exited) return;
    this.pty.kill();
  }

  warned = false;

  private pushOutput(chunk: Buffer): void {
    if (this.socket) {
      this.socket.send(chunk);
      return;
    }
    this.backlog.push(chunk);
    this.backlogBytes += chunk.length;
    while (this.backlogBytes > Session.BACKLOG_CAP && this.backlog.length > 1) {
      const dropped = this.backlog.shift()!;
      this.backlogBytes -= dropped.length;
    }
  }
}

/**
 * Owns all live sessions and the reaper loop:
 * - detached sessions die after the reattach grace window,
 * - idle sessions get a warning, then a 60s stay of execution.
 */
export class SessionRegistry {
  private sessions = new Map<string, Session>();
  private timer: NodeJS.Timeout;

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
    const session = new Session(cols, rows, (s) => this.sessions.delete(s.id));
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  private reap(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.exited) {
        this.sessions.delete(session.id);
        continue;
      }
      const detachedFor = session.detachedAt === null ? 0 : now - session.detachedAt;
      if (!session.hasSocket && detachedFor > this.reattachGraceMs) {
        session.kill();
        continue;
      }
      const idleFor = now - session.lastActivity;
      if (idleFor > this.idleTimeoutMs && !session.warned) {
        session.warned = true;
        session.write(Buffer.from("\r\n\x1b[33m[shell-server] idle timeout in 60s — press any key to keep the session\x1b[0m\r\n"));
      } else if (session.warned && idleFor > this.idleTimeoutMs + 60_000) {
        session.kill();
      }
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const session of this.sessions.values()) session.kill();
  }
}
