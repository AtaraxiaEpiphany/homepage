import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ShellClient } from "./wsClient.js";
import type { ConnState } from "../lib/config.js";
import { TERMINAL_THEMES, applyPageTheme, loadTheme, saveTheme } from "../theme.js";

interface Props {
  onState: (state: ConnState, detail?: string) => void;
  clientRef: (client: ShellClient) => void;
  onOpenPath: (rel: string) => void;
  onPalette: () => void;
  focusRef: { current: (() => void) | null };
  blurRef: { current: (() => void) | null };
}

/**
 * xterm.js ↔ WebSocket ↔ node-pty bridge. Binary frames both ways; the
 * terminal owns the shell's font (Maple Mono) and reflow/resize wiring.
 * Intercepts OSC 7770 — the shell's control channel (`open` pops the viewer,
 * `theme` swaps the page palette, `status` prints server stats).
 */
export function TerminalView({ onState, clientRef, onOpenPath, onPalette, focusRef, blurRef }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;

    const term = new Terminal({
      fontFamily: '"Maple Mono", "JetBrainsMono NFM", "JetBrainsMono Nerd Font Mono", monospace',
      fontSize: 15,
      lineHeight: 1.15,
      cursorBlink: true,
      allowProposedApi: true,
      theme: TERMINAL_THEMES[loadTheme()],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    term.writeln("\x1b[90mstarting shell…\x1b[0m");

    const client = new ShellClient();
    // Deep link: /?cmd=demo injects one command line once the session is
    // online (the pty buffers it until the prompt is live). Length-capped
    // and newline-stripped — it lands as ordinary keystrokes in the same
    // jailed shell, so this is convenience, not an extra authority.
    let deepLinkRan = false;
    client.onState = (state, detail) => {
      onState(state, detail);
      if (state === "online" && !deepLinkRan) {
        deepLinkRan = true;
        const cmd = new URLSearchParams(window.location.search).get("cmd");
        if (cmd) {
          window.history.replaceState(null, "", window.location.pathname);
          const line = cmd.slice(0, 200).replace(/[\r\n]/g, " ");
          window.setTimeout(() => client.input(line + "\r"), 250);
        }
      }
    };
    // The placeholder line above is only visible until the shell's first
    // output arrives; erase it then (it sits one row up — writeln moved the
    // cursor past it) so it doesn't linger in scrollback.
    let bannerCleared = false;
    client.onOutput = (data) => {
      if (!bannerCleared) {
        bannerCleared = true;
        term.write("\x1b[A\r\x1b[2K");
      }
      term.write(data);
    };
    client.onExit = (code) => {
      term.writeln(
        `\r\n\x1b[90m[session exited${code !== null ? ` (code ${code})` : ""} — reload the page for a new shell]\x1b[0m`,
      );
    };
    client.onStatus = (s) => {
      const mins = Math.floor(s.uptimeSec / 60);
      const up =
        mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
      term.writeln(
        `\r\n\x1b[38;5;244m[server] sessions ${s.sessions}/${s.maxSessions} · uptime ${up} · image ${s.image}\x1b[0m`,
      );
    };
    clientRef(client);
    client.connect();
    termRef.current = term;

    term.onData((data) => client.input(data));

    // Ctrl+P / Ctrl+Shift+P (and ⌘P / ⌘⇧P on Mac, where Meta replaces Ctrl)
    // open the command palette. Handled at the document level in the capture
    // phase so it works regardless of which element has focus (the palette is
    // a page-wide affordance, and macOS browsers otherwise eat ⌘⇧P before
    // xterm's textarea would see it); stopPropagation keeps it out of the
    // pty and preventDefault keeps it out of the browser (print dialog /
    // Firefox private window). Plain Ctrl+P is the primary binding — the
    // VS Code muscle memory wins over the shell's previous-history, which ↑
    // and Ctrl-R still cover. Ctrl+K is deliberately left to the shell —
    // emacs kill-line.
    const paletteKeys = (e: KeyboardEvent) => {
      if (
        e.type === "keydown" &&
        !e.repeat &&
        e.code === "KeyP" &&
        (e.ctrlKey || e.metaKey)
      ) {
        e.preventDefault();
        e.stopPropagation();
        onPalette();
      }
    };
    window.addEventListener("keydown", paletteKeys, true);

    // OSC 7770 — the shell→page control channel:
    //   open;<base64url(rel)>  → pop the in-page viewer
    //   theme;dark|light       → swap page + terminal palette (theme cmd)
    //   status;(empty)         → ask server for stats, print the answer
    term.parser.registerOscHandler(7770, (data) => {
      const [action, payload] = data.split(";");
      if (action === "status") {
        client.requestStatus();
        return true;
      }
      if (action === "theme") {
        if (payload !== "dark" && payload !== "light") return false;
        applyPageTheme(payload);
        saveTheme(payload);
        term.options.theme = TERMINAL_THEMES[payload];
        return true;
      }
      if (action !== "open" || !payload) return false;
      const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
      try {
        const rel = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)).trim();
        onOpenPath(rel);
        return true;
      } catch {
        return false;
      }
    });

    // tmux passthrough: inside tmux the shell wraps the OSC in
    // ESC P tmux ; <ESC-doubled payload> ESC \ — real terminals forward DCS,
    // xterm.js consumes it. Unwrap and re-feed the inner sequence.
    term.parser.registerDcsHandler({ final: "\\" }, (data) => {
      if (!data.startsWith("tmux;")) return false;
      const inner = data.slice(5).replace(/\x1b\x1b/g, "\x1b");
      term.write(inner);
      return true;
    });

    focusRef.current = () => term.focus();
    blurRef.current = () => term.blur();
    // dev/test hook: lets verification scripts read the buffer
    if (import.meta.env.DEV) (window as unknown as { __term?: Terminal }).__term = term;

    const doFit = () => {
      try {
        fit.fit();
        client.resize(term.cols, term.rows);
      } catch {
        /* container not measurable yet */
      }
    };
    const ro = new ResizeObserver(doFit);
    ro.observe(hostRef.current);
    doFit();
    // Fade the frame in only once the web font is live and the fit is final —
    // masks the pre-JS full-width frame and the font-swap reflow. The guard
    // covers unmount racing font load (StrictMode double-mount): fitting a
    // disposed term throws.
    document.fonts.ready.then(() => {
      if (termRef.current !== term) return;
      doFit();
      hostRef.current?.classList.add("ready");
    });
    term.focus();

    return () => {
      window.removeEventListener("keydown", paletteKeys, true);
      ro.disconnect();
      client.dispose();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="terminal-frame" aria-label="terminal">
      <div ref={hostRef} className="terminal-host" />
    </section>
  );
}
