import { spawn } from "node:child_process";
import { BOX_RUN_FLAGS, config } from "./config.js";

/**
 * The persistent shell box: ONE long-lived container (`docker run -d … sleep
 * infinity`) that every session jails into via `docker exec`. Replaces the
 * old docker-run-per-session shape — container startup cost is paid once at
 * server boot, and each session costs only an exec + bwrap. The box keeps
 * CAP_SYS_ADMIN (bwrap builds the jail mounts); jail-login drops to the
 * session uid before the shell runs.
 */

const runDocker = (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`docker ${args[0]} exited ${code}: ${stderr.trim()}`)),
    );
  });

/**
 * Idempotent: reuse a healthy box, replace anything else. Replacing on boot
 * also guarantees a clean slate — any jail process orphaned by a previous
 * server crash dies with the old container, so no stale tenant survives a
 * restart even if its stray-kill never ran.
 */
export async function ensureBox(): Promise<void> {
  const name = config.boxContainer;
  const healthy = await new Promise<boolean>((resolve) => {
    const child = spawn("docker", ["inspect", "-f", "{{.State.Running}}", name], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0 && out.trim() === "true"));
  });
  if (healthy) return;
  await runDocker(["rm", "-f", name]).catch(() => {});
  await runDocker(["run", ...BOX_RUN_FLAGS]);
}

/** Best-effort sweep of a session's processes after its exec client died. */
export function killStrays(uid: number): Promise<void> {
  return runDocker(["exec", config.boxContainer, "pkill", "-KILL", "-U", String(uid)]).catch(
    () => {},
  );
}

export function disposeBox(): Promise<void> {
  return runDocker(["rm", "-f", config.boxContainer]).catch(() => {});
}
