import { config } from "./config.js";

/**
 * Per-session jail uids (tulipjN, uid base..base+slots-1, fixed at image
 * build time). One uid per live session — bwrap drops to it via setpriv,
 * so kernel per-uid accounting (RLIMIT_NPROC, process ownership) becomes
 * per-session isolation for free. Release happens only after the box-side
 * stray-kill completed, so a recycled uid never inherits a live process.
 */
const free: number[] = [];
for (let i = 0; i < config.jailUidSlots; i++) free.push(config.jailUidBase + i);

export function leaseUid(): number {
  const uid = free.shift();
  if (uid === undefined) {
    // Unreachable while slots >= maxSessions (the admission invariant bounds
    // live sessions); a spawn_failed refund is the honest answer if ever hit.
    throw new Error("no free jail uids");
  }
  return uid;
}

export function releaseUid(uid: number): void {
  if (!free.includes(uid)) free.push(uid);
}
