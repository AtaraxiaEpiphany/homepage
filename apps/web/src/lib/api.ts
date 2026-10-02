import { API_URL } from "./config.js";

export async function fetchFile(rel: string): Promise<string> {
  const res = await fetch(`${API_URL}/api/file?path=${encodeURIComponent(rel)}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.text();
}

export async function fetchFileList(): Promise<string[]> {
  const res = await fetch(`${API_URL}/api/files`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { files: string[] };
  return body.files;
}

const RECENTS_KEY = "homepage:recents";
const RECENTS_MAX = 10;

/** localStorage LRU of recently opened files (per-viewer convenience). */
export function pushRecent(rel: string): void {
  try {
    const cur: string[] = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    const next = [rel, ...cur.filter((f) => f !== rel)].slice(0, RECENTS_MAX);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* private mode / disabled storage — recents are a nicety, not a feature */
  }
}

export function getRecents(): string[] {
  try {
    const all = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]") as string[];
    // drop legacy entries saved with a trailing newline (pre-trim OSC bug)
    return all.filter((f) => typeof f === "string" && !/\s/.test(f));
  } catch {
    return [];
  }
}
