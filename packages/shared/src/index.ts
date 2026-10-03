// WebSocket protocol shared by apps/web and apps/shell-server.
//
// Framing rules:
// - Control messages are JSON **text** frames (C2S / S2C below).
// - Keyboard input (client -> server) and PTY output (server -> client) are
//   raw **binary** frames — byte fidelity, no base64 overhead; both ends treat
//   the bytes opaquely so split multibyte UTF-8 sequences are safe.

/** Client -> Server (JSON text frames). */
export type C2S =
  | { type: "create" }
  /** Reattach to a live session after a WS drop, within the grace window. */
  | { type: "attach"; sessionId: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "status" }
  | { type: "ping" };

/** Server -> Client (JSON text frames). */
export type S2C =
  | { type: "created"; sessionId: string }
  /** ok=false means the session is gone; client must send `create`. */
  | { type: "attached"; sessionId: string; ok: boolean }
  | { type: "exit"; exitCode: number | null }
  | { type: "error"; code: "server_full" | "spawn_failed" | "busy"; message: string }
  /** Answer to the `status` control frame — server-side shell stats. */
  | { type: "status"; sessions: number; maxSessions: number; uptimeSec: number; image: string }
  | { type: "pong" };

/** Extensions the markdown viewer renders as rich markdown; everything else is shown as plain text. */
export const OPENABLE_EXTENSIONS = new Set(["md", "markdown", "txt"]);

export function isMarkdownPath(path: string): boolean {
  const ext = path.split(".").pop() ?? "";
  return OPENABLE_EXTENSIONS.has(ext) && ext !== "txt";
}
