// WebSocket protocol shared by apps/web and apps/shell-server.
//
// Framing rules:
// - Control messages are JSON **text** frames (C2S / S2C below).
// - Keyboard input (client -> server) and PTY output (server -> client) are
//   raw **binary** frames — byte fidelity, no base64 overhead; both ends treat
//   the bytes opaquely so split multibyte UTF-8 sequences are safe.

/** Client -> Server (JSON text frames). */
export type C2S =
  | {
      /** First-frame gate, required when the server runs with WS_TOKEN set. */
      type: "auth";
      token: string;
    }
  | { type: "create" }
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
  | { type: "error"; code: "server_full" | "spawn_failed" | "busy" | "draining"; message: string }
  /** Answer to the `status` control frame — server-side shell stats. */
  | { type: "status"; sessions: number; maxSessions: number; uptimeSec: number; image: string }
  | { type: "pong" };

/** Extensions the markdown viewer renders as rich markdown; everything else is shown as plain text. */
export const OPENABLE_EXTENSIONS = new Set(["md", "markdown", "txt"]);

export function isMarkdownPath(path: string): boolean {
  const ext = path.split(".").pop() ?? "";
  return OPENABLE_EXTENSIONS.has(ext) && ext !== "txt";
}
