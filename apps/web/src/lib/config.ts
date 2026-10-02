// Runtime config for the frontend.
//
// - Dev: same-origin /ws + /api (vite proxies to the local shell-server).
// - Prod (GH Pages): build-time VITE_WS_URL / VITE_API_URL must point at a
//   reachable shell backend; without one the app renders its offline overlay.

const env = import.meta.env;

export const WS_URL: string =
  env.VITE_WS_URL || (env.DEV ? `ws://${location.host}/ws` : "");

export const API_URL: string =
  env.VITE_API_URL || (env.DEV ? "" : "");

export type ConnState = "connecting" | "online" | "offline";
