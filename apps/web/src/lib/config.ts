// Runtime config for the frontend.
//
// - Dev: same-origin /ws + /api (vite proxies to the local shell-server).
// - Prod (GH Pages): build-time VITE_WS_URL / VITE_API_URL must point at a
//   reachable shell backend; without one the app renders its offline overlay.

const env = import.meta.env;

export const WS_URL: string =
  env.VITE_WS_URL || (env.DEV ? `ws://${location.host}/ws` : "");

/**
 * Shared secret for token-authenticated servers, sent as the first WS frame.
 * WARNING: baked into the shipped JS bundle — only set for private frontend
 * hosting; on a public bundle it is public knowledge.
 */
export const WS_TOKEN: string = env.VITE_WS_TOKEN || "";

export const API_URL: string =
  env.VITE_API_URL || (env.DEV ? "" : "");

/**
 * Broker pre-flight endpoint (multi-host deployments): the base URL of a
 * broker-enabled shell host, e.g. `https://shells.example.com`. Empty keeps
 * the connection flow byte-identical to single-host (WS first, queue held
 * server-side over that WS).
 */
export const BROKER_URL: string = env.VITE_BROKER_URL || "";

export type ConnState = "connecting" | "online" | "offline" | "queued";

/**
 * Queue depth at which the overlay starts playing the demo replay alongside
 * the position counter — deep enough that waiting looks likely.
 */
export const REPLAY_AFTER_POSITION = 2;

/** Admission outcomes that mean "the visitor is stuck at the door". */
export const PRESSURE_CODES = new Set(["server_full", "queue_full", "queue_timeout", "visitor_limit"]);
