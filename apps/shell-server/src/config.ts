import path from "node:path";
import { existsSync } from "node:fs";
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
  /** Shared secret for the WS upgrade (?token=...). Empty string disables auth (local dev). */
  token: process.env.WS_TOKEN ?? "",
  maxSessions: int("MAX_SESSIONS", 4),
  /** Kill a session idle this long (ms), after a warning written into the PTY. */
  idleTimeoutMs: int("IDLE_TIMEOUT_MS", 30 * 60_000),
  /** Keep a detached session alive this long (ms) so the client can reattach. */
  reattachGraceMs: int("REATTACH_GRACE_MS", 30_000),
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
  "--tmpfs", "/home/dev:rw,nosuid,size=64m,uid=1000,mode=755",
  "--mount", `type=bind,src=${config.contentDir},dst=/home/dev/content,ro,bind-recursive=disabled`,
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
