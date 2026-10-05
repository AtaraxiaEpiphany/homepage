/**
 * Stable per-browser fairness key. The server uses it to queue fairly and to
 * budget sessions per visitor; it is not a secret and not a login — clearing
 * storage sheds it, and that is acceptable (the abuse floor lives on the
 * socket address; availability never depends on this token existing).
 */

const KEY = "homepage:visitor";
const VISITOR_RE = /^[\w-]{8,128}$/;

const randomToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Existing token, or a freshly minted one; "" when storage is unavailable. */
export function getVisitor(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing && VISITOR_RE.test(existing)) return existing;
    const fresh = randomToken();
    localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    return "";
  }
}
