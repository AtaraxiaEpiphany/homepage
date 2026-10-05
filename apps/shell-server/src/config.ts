import path from "node:path";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const int = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Repo-root-anchored default so the server's cwd doesn't matter. */
const REPO_ROOT = path.resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const config = {
  port: int("WS_PORT", 8787),
  /**
   * Bind address. Loopback by default: a tokenless (public-mode) server must
   * never be routable — the guard below refuses any wider bind without a token.
   */
  host: process.env.WS_HOST ?? "127.0.0.1",
  /** Shared secret for WS auth. Empty string = public mode, loopback-only (see guard below). */
  token: process.env.WS_TOKEN ?? "",
  /**
   * Shared secret for the ops endpoints (/api/hosts, /api/metrics), sent as
   * `Authorization: Bearer <token>`. Empty falls back to WS_TOKEN; both empty
   * (dev, loopback-only server) leaves the ops endpoints open like the rest.
   */
  opsToken: process.env.OPS_TOKEN || process.env.WS_TOKEN || "",
  maxSessions: int("MAX_SESSIONS", 4),
  /** Kill a session idle this long (ms), after a warning written into the PTY. */
  idleTimeoutMs: int("IDLE_TIMEOUT_MS", 30 * 60_000),
  /** Keep a detached session alive this long (ms) so the client can reattach. */
  reattachGraceMs: int("REATTACH_GRACE_MS", 30_000),
  /** Shutdown budget (ms): refuse new sessions, let live ones drain, then kill. */
  drainTimeoutMs: int("DRAIN_TIMEOUT_MS", 10_000),
  /**
   * Abuse floor (per raw socket IP — never forwarded headers): create
   * throttle, auth-failure lockout, concurrent-WS cap. Behind a proxy all
   * visitors share one bucket on purpose; RATE_LIMIT_DISABLED=1 lifts the
   * floor entirely (private deployments behind an auth proxy).
   */
  createRatePerMin: int("CREATE_RATE_PER_MIN", 6),
  createRateBurst: int("CREATE_RATE_BURST", 6),
  authMaxFailures: int("AUTH_MAX_FAILURES", 5),
  authLockoutMs: int("AUTH_LOCKOUT_MS", 60_000),
  maxWsPerIp: int("MAX_WS_PER_IP", 8),
  rateLimitDisabled: process.env.RATE_LIMIT_DISABLED === "1",
  /** Waiting room: sessions per visitor (browser token), queue depth, queue TTL. */
  visitorMaxSessions: int("VISITOR_MAX_SESSIONS", 1),
  queueMax: int("QUEUE_MAX", 8),
  queueTimeoutMs: int("QUEUE_TIMEOUT_MS", 120_000),
  /** Warm pool: pre-spawned shells ready at create time (inside the max budget). */
  poolSize: int("POOL_SIZE", 2),
  /** Max age of an unclaimed pool shell before it is churned. */
  poolShellTtlMs: int("POOL_SHELL_TTL_MS", 600_000),
  /** Saturation floors for the adaptive grace/idle shrink. */
  minReattachGraceMs: int("MIN_REATTACH_GRACE_MS", 5_000),
  minIdleTimeoutMs: int("MIN_IDLE_TIMEOUT_MS", 180_000),
  /**
   * Broker mode (multi-host): shared redis holding admission state (queue,
   * tickets, visitor budgets, host presence). Empty = single-host memory
   * store. Data-plane WS traffic stays client↔host direct; redis is the
   * control plane only.
   */
  brokerRedisUrl: process.env.BROKER_REDIS_URL ?? "",
  /** This host's id in the broker presence registry — unique per instance. */
  hostId: process.env.HOST_ID ?? `${hostname()}-${process.pid}`,
  /**
   * WS base URL (wss://…) clients are told to connect to when this host
   * grants them a slot. Empty = same public origin (all hosts behind one
   * reverse proxy routing /ws to whichever is up).
   */
  hostPublicUrl: process.env.HOST_PUBLIC_URL ?? "",
  /** Comma-separated CORS allowlist for /api/admit; empty = reflect any origin (dev). */
  corsOrigins: (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** Read-only content jail exposed to the shell and the /api/file* routes. */
  contentDir: path.resolve(process.env.CONTENT_DIR ?? path.join(REPO_ROOT, "content")),
  image: process.env.IMAGE ?? "homepage-shell:latest",
};

export const DOCKER_RUN_FLAGS = [
  "run",
  "--rm",
  "--interactive",
  "--tty",
  "--init",
  "--user", "1000:1000",
  "--read-only",
  "--tmpfs", "/tmp:rw,nosuid,size=64m,mode=1777",
  "--tmpfs", "/home/tulip:rw,nosuid,size=64m,uid=1000,mode=755",
  "--mount", `type=bind,src=${config.contentDir},dst=/home/tulip/content,ro,bind-recursive=disabled`,
  "--cap-drop=ALL",
  "--security-opt", "no-new-privileges",
  "--pids-limit", "256",
  "--memory", "512m",
  "--cpus", "1.0",
  "--network", "none",
  config.image,
  "zsh",
  "-l",
];

if (!existsSync(config.contentDir)) {
  throw new Error(`CONTENT_DIR does not exist: ${config.contentDir}`);
}

/**
 * Public mode (no WS_TOKEN) hands a jailed shell to every connected client —
 * only acceptable on loopback, where a local reverse proxy forwards to us.
 * Fail closed at load so a wide bind never comes up unauthenticated.
 */
const isLoopbackHost = (h: string): boolean =>
  h === "localhost" || h === "::1" || h.startsWith("127.");

if (config.token === "" && !isLoopbackHost(config.host)) {
  throw new Error(
    `refusing to bind ${config.host} without WS_TOKEN — a no-auth shell server must stay on loopback. ` +
      "Set WS_TOKEN to serve beyond loopback (clients then auth with a first-frame message; the frontend needs VITE_WS_TOKEN), " +
      "or keep WS_HOST=127.0.0.1 and point a local reverse proxy at it.",
  );
}
