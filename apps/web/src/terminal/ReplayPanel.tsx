import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { parseCast, playCast, type Playing } from "./castPlayer.js";
import { API_URL } from "../lib/config.js";
import { TERMINAL_THEMES, loadTheme } from "../theme.js";

/**
 * The demo-replay fallback: plays content/replay.cast into a small read-only
 * terminal inside the overlay while the real shell is unreachable (queue too
 * deep or admission rejected). The cast is optional — a missing one just
 * prints a dim note.
 */
export function ReplayPanel({ onJoin }: { onJoin: () => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: '"Maple Mono", "JetBrainsMono NFM", "JetBrainsMono Nerd Font Mono", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      disableStdin: true,
      scrollback: 200,
      theme: TERMINAL_THEMES[loadTheme()],
    });
    term.open(host);
    term.writeln("\x1b[2mdemo replay — what the shell can do:\x1b[0m");
    let playing: Playing | null = null;
    let cancelled = false;

    fetch(`${API_URL}/api/replay`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => {
        if (cancelled) return;
        playing = playCast(term, parseCast(text).events);
      })
      .catch(() => {
        if (!cancelled) term.write("\x1b[2m(no replay available)\x1b[0m\r\n");
      });

    return () => {
      cancelled = true;
      playing?.stop();
      term.dispose();
    };
  }, []);

  return (
    <div className="replay-panel">
      <div className="replay-host" ref={hostRef} />
      <button className="offline-retry" onClick={onJoin}>
        join the real shell →
      </button>
    </div>
  );
}
