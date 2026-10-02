import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ShellClient } from "./wsClient.js";
import type { ConnState } from "../lib/config.js";

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
 * terminal owns the shell's font (Nerd Font Mono) and reflow/resize wiring.
 * Intercepts OSC 7770 (`open` in the shell) to pop the in-page viewer.
 */
export function TerminalView({ onState, clientRef, onOpenPath, onPalette, focusRef, blurRef }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;

    const term = new Terminal({
      fontFamily: '"JetBrainsMono NFM", "JetBrainsMono Nerd Font Mono", monospace',
      fontSize: 14,
      lineHeight: 1.15,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: "#141310",
        foreground: "#e8e4d8",
        cursor: "#b3432b",
        selectionBackground: "#3a3a32",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    term.writeln("\x1b[90mstarting shell…\x1b[0m");

    const client = new ShellClient();
    client.onState = onState;
    client.onOutput = (data) => term.write(data);
    client.onExit = (code) => {
      term.writeln(
        `\r\n\x1b[90m[session exited${code !== null ? ` (code ${code})` : ""} — reload the page for a new shell]\x1b[0m`,
      );
    };
    clientRef(client);
    client.connect();
    termRef.current = term;

    term.onData((data) => client.input(data));

    // Ctrl+Shift+P opens the command palette; returning false keeps the
    // keystroke out of the pty. (Ctrl+K is deliberately left to the shell —
    // it is emacs kill-line.)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && e.code === "KeyP") {
        onPalette();
        return false;
      }
      return true;
    });

    // open <path> — shell emits ESC]7770;open;<base64url(rel)>BEL
    term.parser.registerOscHandler(7770, (data) => {
      const [action, payload] = data.split(";");
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
    term.focus();

    return () => {
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
