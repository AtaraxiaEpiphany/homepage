// WebSocket protocol shared by apps/web and apps/shell-server.
//
// Framing rules:
// - Control messages are JSON **text** frames (C2S / S2C below).
// - Keyboard input (client -> server) and PTY output (server -> client) are
//   raw **binary** frames — byte fidelity, no base64 overhead; both ends treat
//   the bytes opaquely so split multibyte UTF-8 sequences are safe.

/**
 * Stable per-browser fairness key (random, held in localStorage). Optional
 * everywhere: absent = the client is budget-exempt (availability never
 * depends on identity). The server treats it as opaque and validates shape.
 */
export interface VisitorFields {
  visitor?: string;
}

/** Client -> Server (JSON text frames). */
export type C2S =
  | ({
      /** First-frame gate, required when the server runs with WS_TOKEN set. */
      type: "auth";
      token: string;
    } & VisitorFields)
  | ({ type: "create" } & VisitorFields)
  /**
   * Reattach to a live session after a WS drop, within the grace window.
   * `secret` is the per-session bearer proof issued once in `created`.
   */
  | { type: "attach"; sessionId: string; secret: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "status" }
  | { type: "ping" };

/** Server -> Client (JSON text frames). */
export type S2C =
  | {
      /** `secret` is the bearer proof `attach` must present. */
      type: "created";
      sessionId: string;
      secret: string;
    }
  /** ok=false means the session is gone or the proof was rejected; client must send `create`. */
  | { type: "attached"; sessionId: string; ok: boolean }
  | { type: "exit"; exitCode: number | null }
  /**
   * `rate_limited` throttles create spam (connection stays open — retry later
   * on the same socket); `locked_out` and the 4403 close code mean repeated
   * auth failures; `draining` = shutdown in progress.
   */
  | {
      type: "error";
      code: "server_full" | "spawn_failed" | "busy" | "draining" | "rate_limited" | "locked_out";
      message: string;
    }
  /** Answer to the `status` control frame — server-side shell stats. */
  | { type: "status"; sessions: number; maxSessions: number; uptimeSec: number; image: string }
  | { type: "pong" };

/**
 * Extra WS close codes this protocol uses beyond 4401 (auth) and 4409
 * (superseded): 4403 = IP locked out after repeated auth failures,
 * 4429 = per-IP concurrent-connection cap.
 */
export const WS_CLOSE_LOCKED_OUT = 4403;
export const WS_CLOSE_WS_LIMIT = 4429;

/** Extensions the markdown viewer renders as rich markdown; everything else is shown as plain text. */
export const OPENABLE_EXTENSIONS = new Set(["md", "markdown", "txt"]);

export function isMarkdownPath(path: string): boolean {
  const ext = path.split(".").pop() ?? "";
  return OPENABLE_EXTENSIONS.has(ext) && ext !== "txt";
}
