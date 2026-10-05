import { BROKER_URL, WS_URL } from "./config.js";

/**
 * Client side of the broker control plane (phase: multi-host). The shell
 * data plane stays WS-direct — this module only reserves a slot:
 *
 *   admit() → granted{ticket, endpoint} → connect there, create{ticket}
 *           → queued{ticket, position} → pollQueue() until granted
 *
 * Gated on VITE_BROKER_URL: unset, every call short-circuits and the
 * wsClient falls through to the single-host flow untouched.
 */

const POLL_MS = 2_000;

export type AdmitResult =
  | { kind: "granted"; ticket: string; endpoint: string | null }
  | { kind: "queued"; ticket: string; position: number }
  | { kind: "rejected"; code: string }
  | { kind: "unavailable" };

export type QueuePoll =
  | { kind: "queued"; position: number }
  | { kind: "granted"; endpoint: string | null }
  | { kind: "expired" }
  | { kind: "unavailable" };

/** Turn a broker endpoint into a WS URL; null = this build's default. */
export function endpointToWsUrl(endpoint: string | null): string {
  if (!endpoint) return WS_URL;
  let url = endpoint.replace(/^http/i, "ws"); // https:// → wss://, http:// → ws://
  if (!/\/\//.test(url)) url = `ws://${url}`; // bare host:port
  if (!/^wss?:\/\//.test(url)) url = `wss://${url}`;
  // A bare origin has no socket path — the server route is /ws.
  if (!/^wss?:\/\/[^/]+\/.+/.test(url)) url = url.replace(/\/?$/, "/ws");
  return url;
}

export async function admit(visitor: string): Promise<AdmitResult> {
  if (BROKER_URL === "") return { kind: "unavailable" };
  try {
    const res = await fetch(`${BROKER_URL}/api/admit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visitor: visitor || undefined }),
    });
    if (res.status === 429 || res.status === 503) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { kind: "rejected", code: body.error ?? "rate_limited" };
    }
    if (!res.ok) return { kind: "unavailable" };
    const body = (await res.json()) as {
      granted?: boolean;
      queued?: boolean;
      ticket?: string;
      endpoint?: string | null;
      position?: number;
    };
    if (body.granted && body.ticket) {
      return { kind: "granted", ticket: body.ticket, endpoint: body.endpoint ?? null };
    }
    if (body.queued && body.ticket) {
      return { kind: "queued", ticket: body.ticket, position: body.position ?? 0 };
    }
    return { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

export async function pollQueue(ticket: string): Promise<QueuePoll> {
  if (BROKER_URL === "") return { kind: "unavailable" };
  try {
    const res = await fetch(`${BROKER_URL}/api/queue/${encodeURIComponent(ticket)}`);
    if (res.status === 404) return { kind: "expired" };
    if (!res.ok) return { kind: "unavailable" };
    const body = (await res.json()) as {
      granted?: boolean;
      queued?: boolean;
      endpoint?: string | null;
      position?: number;
    };
    if (body.granted) return { kind: "granted", endpoint: body.endpoint ?? null };
    if (body.queued) return { kind: "queued", position: body.position ?? 0 };
    return { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

export { POLL_MS };
