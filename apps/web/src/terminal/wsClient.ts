import type { C2S, S2C } from "@homepage/shared";
import { WS_URL, type ConnState } from "../lib/config.js";

const SESSION_KEY = "homepage:sessionId";

/**
 * Browser side of the shell bridge.
 *
 * - Control: JSON text frames (create / attach / resize / ping ...).
 * - I/O: raw binary frames — keyboard bytes out, PTY bytes in.
 * - Reconnect: exponential backoff (0.5s → 8s); reattaches to the live
 *   session by id (kept in sessionStorage) before falling back to create.
 */
export class ShellClient {
  private ws: WebSocket | null = null;
  private state: ConnState = "connecting";
  private backoffMs = 500;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private disposed = false;
  private pendingResize: { cols: number; rows: number } | null = null;

  onState: (state: ConnState, detail?: string) => void = () => {};
  onOutput: (data: Uint8Array) => void = () => {};
  onExit: (exitCode: number | null) => void = () => {};

  private setState(state: ConnState, detail?: string): void {
    if (this.state !== state) {
      this.state = state;
      this.onState(state, detail);
    }
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
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (saved) {
        this.send({ type: "attach", sessionId: saved });
      } else {
        this.send({ type: "create" });
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

    ws.onclose = () => {
      this.stopPings();
      if (this.disposed) return;
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
        sessionStorage.setItem(SESSION_KEY, msg.sessionId);
        this.backoffMs = 500;
        this.setState("online");
        this.startPings();
        if (this.pendingResize) this.send({ type: "resize", ...this.pendingResize });
        break;
      }
      case "attached": {
        if (msg.ok) {
          this.backoffMs = 500;
          this.setState("online");
          this.startPings();
          if (this.pendingResize) this.send({ type: "resize", ...this.pendingResize });
        } else {
          sessionStorage.removeItem(SESSION_KEY);
          this.send({ type: "create" });
        }
        break;
      }
      case "exit": {
        sessionStorage.removeItem(SESSION_KEY);
        this.onExit(msg.exitCode);
        break;
      }
      case "error": {
        this.onOutput(
          new TextEncoder().encode(
            `\r\n\x1b[31m[shell-server] ${msg.code}: ${msg.message}\x1b[0m\r\n`,
          ),
        );
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

  /** Drop the saved session and start a fresh one (palette "restart session"). */
  restart(): void {
    sessionStorage.removeItem(SESSION_KEY);
    this.ws?.close();
  }

  dispose(): void {
    this.disposed = true;
    this.stopPings();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
