import type { C2S, S2C } from "@homepage/shared";
import { PRESSURE_CODES, REPLAY_AFTER_POSITION, WS_TOKEN, WS_URL, type ConnState } from "../lib/config.js";
import { getVisitor } from "../lib/visitor.js";

const SESSION_KEY = "homepage:sessionId";

/** What sessionStorage holds: the id plus its bearer proof from `created`. */
interface StoredSession {
  id: string;
  secret: string;
}

/**
 * Browser side of the shell bridge.
 *
 * - Control: JSON text frames (auth / create / attach / resize / ping ...).
 * - I/O: raw binary frames — keyboard bytes out, PTY bytes in.
 * - Reconnect: exponential backoff (0.5s → 8s); reattaches to the live
 *   session by id + secret (kept in sessionStorage) before falling back to
 *   create. Auth failures (4401) and takeovers (4409) never auto-reconnect:
 *   a retry cannot succeed, and re-attaching after a takeover would fight
 *   the winner.
 */
export class ShellClient {
  private ws: WebSocket | null = null;
  private state: ConnState = "connecting";
  private backoffMs = 500;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private disposed = false;
  private pendingResize: { cols: number; rows: number } | null = null;
  /** Set by restart() so onclose reconnects immediately instead of backing off. */
  private restartPending = false;

  onState: (state: ConnState, detail?: string) => void = () => {};
  onOutput: (data: Uint8Array) => void = () => {};
  onExit: (exitCode: number | null) => void = () => {};
  /** Answer to requestStatus() — server-side stats for the `status` command. */
  onStatus: (info: {
    sessions: number;
    maxSessions: number;
    uptimeSec: number;
    image: string;
  }) => void = () => {};
  /** Admission pressure flipped on/off — the overlay offers the demo replay. */
  onPressure: (active: boolean) => void = () => {};

  private pressure = false;

  private setPressure(active: boolean): void {
    if (this.pressure !== active) {
      this.pressure = active;
      this.onPressure(active);
    }
  }

  private setState(state: ConnState, detail?: string): void {
    if (this.state !== state) {
      this.state = state;
      this.onState(state, detail);
    }
  }

  /**
   * Session id + secret from sessionStorage, or null. Shape-validating: a
   * pre-secret entry (bare session id) fails the check and is dropped, which
   * migrates old tabs to the new format on their next reload.
   */
  private readStored(): StoredSession | null {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredSession>;
      if (typeof parsed.id === "string" && typeof parsed.secret === "string") {
        return { id: parsed.id, secret: parsed.secret };
      }
    } catch {
      // fall through to removal
    }
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }

  // Not connected in the constructor: callers assign the callbacks right
  // after construction, and the no-backend path fires onState synchronously.
  connect(): void {
    if (this.disposed) return;
    if (!WS_URL) {
      this.setState("offline", "VITE_WS_URL is not configured for this build");
      return;
    }
    this.setState("connecting");
    const ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      // Auth first when the server runs token mode; frames arrive in order,
      // so create/attach simply queue behind the handshake. The visitor token
      // rides along wherever the protocol accepts it; empty = storage
      // blocked, and the server treats us as budget-exempt.
      const visitor = getVisitor();
      if (WS_TOKEN) this.send({ type: "auth", token: WS_TOKEN, visitor });
      const saved = this.readStored();
      if (saved) {
        this.send({ type: "attach", sessionId: saved.id, secret: saved.secret });
      } else {
        this.send({ type: "create", visitor });
        this.startPings();
      }
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        this.onControl(JSON.parse(ev.data) as S2C);
      } else {
        this.onOutput(new Uint8Array(ev.data));
      }
    };

    ws.onclose = (ev) => {
      this.stopPings();
      this.setPressure(false); // a dead backend can't serve the replay either
      if (this.disposed) return;
      if (this.restartPending) {
        this.restartPending = false;
        this.connect();
        return;
      }
      if (ev.code === 4401) {
        // Build-time token mismatch — reconnecting cannot fix it.
        this.setState("offline", "unauthorized — server requires WS_TOKEN (build with VITE_WS_TOKEN)");
        return;
      }
      if (ev.code === 4409) {
        // Superseded by another window; stealing back would ping-pong forever.
        sessionStorage.removeItem(SESSION_KEY);
        this.setState("offline", "session taken over by another window — retry for a fresh shell");
        return;
      }
      this.setState("offline");
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  private onControl(msg: S2C): void {
    switch (msg.type) {
      case "created": {
        sessionStorage.setItem(
          SESSION_KEY,
          JSON.stringify({ id: msg.sessionId, secret: msg.secret }),
        );
        this.backoffMs = 500;
        this.setPressure(false);
        this.setState("online");
        this.startPings();
        if (this.pendingResize) this.send({ type: "resize", ...this.pendingResize });
        break;
      }
      case "attached": {
        if (msg.ok) {
          this.backoffMs = 500;
          this.setPressure(false);
          this.setState("online");
          this.startPings();
          if (this.pendingResize) this.send({ type: "resize", ...this.pendingResize });
        } else {
          sessionStorage.removeItem(SESSION_KEY);
          this.send({ type: "create", visitor: getVisitor() });
        }
        break;
      }
      case "queued": {
        // Waiting-room ticket. Pings continue so proxies don't drop an
        // "idle" connection while it holds the queue spot.
        this.setState("queued", `position ${msg.position}`);
        this.setPressure(msg.position > REPLAY_AFTER_POSITION);
        this.startPings();
        break;
      }
      case "queue_update": {
        // position 0 = about to be granted; `created` lands momentarily.
        if (this.state === "queued" && msg.position > 0) {
          this.setState("queued", `position ${msg.position}`);
          this.setPressure(msg.position > REPLAY_AFTER_POSITION);
        }
        break;
      }
      case "exit": {
        sessionStorage.removeItem(SESSION_KEY);
        this.onExit(msg.exitCode);
        break;
      }
      case "status": {
        this.onStatus(msg);
        break;
      }
      case "error": {
        this.onOutput(
          new TextEncoder().encode(
            `\r\n\x1b[31m[shell-server] ${msg.code}: ${msg.message}\x1b[0m\r\n`,
          ),
        );
        // An error before we ever come online (e.g. server_full answering a
        // create) otherwise leaves the state stuck on "connecting" — surface
        // it in the overlay instead, where retry stays reachable.
        if (this.state !== "online") {
          this.setState("offline", `${msg.code}: ${msg.message}`);
        }
        this.setPressure(PRESSURE_CODES.has(msg.code));
        break;
      }
      case "pong":
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 2, 8000);
      this.connect();
    }, this.backoffMs);
  }

  private startPings(): void {
    this.stopPings();
    this.pingTimer = window.setInterval(() => this.send({ type: "ping" }), 25_000);
  }

  private stopPings(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private send(msg: C2S): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  input(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(new TextEncoder().encode(data));
    }
  }

  resize(cols: number, rows: number): void {
    this.pendingResize = { cols, rows };
    this.send({ type: "resize", cols, rows });
  }

  /** Ask the server for stats; the answer arrives via onStatus. */
  requestStatus(): void {
    this.send({ type: "status" });
  }

  /**
   * Drop the saved session and start a fresh one (palette "restart session").
   * Must work from any state — including the offline overlay after a 4401/
   * 4409 close, which are exactly the states that suppress auto-reconnect.
   */
  restart(): void {
    sessionStorage.removeItem(SESSION_KEY);
    this.backoffMs = 500;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPings();
    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      this.restartPending = true;
      ws.close(); // onclose sees restartPending and reconnects immediately
    } else {
      this.connect();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopPings();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
