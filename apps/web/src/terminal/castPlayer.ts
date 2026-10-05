/**
 * asciinema v2 cast parsing and playback. The player is a plain timer chain
 * over the JSONL event list writing into any { write(s) } sink — an xterm.js
 * Terminal in the overlay. Long pauses are capped so a quiet recording never
 * stalls the fallback.
 */

export interface CastEvent {
  /** Absolute event time in seconds (asciinema convention). */
  t: number;
  data: string;
}

export interface ParsedCast {
  width: number;
  height: number;
  events: CastEvent[];
}

export function parseCast(text: string): ParsedCast {
  const lines = text.split("\n");
  let width = 80;
  let height = 24;
  try {
    const header = JSON.parse(lines[0]!) as { width?: number; height?: number };
    width = header.width ?? width;
    height = header.height ?? height;
  } catch {
    /* defaults below */
  }
  const events: CastEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const [t, kind, data] = JSON.parse(line) as [number, string, unknown];
      if (kind === "o" && typeof data === "string") events.push({ t: Number(t), data });
    } catch {
      /* skip malformed line */
    }
  }
  return { width, height, events };
}

export interface Playing {
  stop(): void;
  done: Promise<void>;
}

export function playCast(
  term: { write(s: string): void },
  events: CastEvent[],
  opts?: { speed?: number; maxGapMs?: number },
): Playing {
  const speed = opts?.speed ?? 1;
  const maxGapMs = opts?.maxGapMs ?? 400;
  let i = 0;
  let timer: number | null = null;
  let stopped = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const step = (): void => {
    if (stopped) return;
    const ev = events[i];
    if (ev === undefined) {
      resolveDone();
      return;
    }
    term.write(ev.data);
    i += 1;
    const next = events[i];
    const delta = next === undefined ? 0 : Math.min(((next.t - ev.t) * 1000) / speed, maxGapMs);
    timer = window.setTimeout(step, Math.max(0, delta));
  };
  timer = window.setTimeout(step, 0);

  return {
    stop() {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      resolveDone();
    },
    done,
  };
}
